<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import Modal from "$lib/shared-shell/components/Modal.svelte";
  import type { OctopusBeakApi } from "$lib/desktop/api.ts";
  import { t } from "$lib/i18n/i18n.ts";
  import type { RunLiveViewEndReason, RunLiveViewFrame } from "./run-intervention.ts";

  /** What the dialog shows; frames stay in this component's memory and nowhere else (ADR 0147). */
  type LiveViewState =
    | { kind: "opening" }
    | { kind: "live"; viewId: string; frame: RunLiveViewFrame | null }
    | { kind: "ended"; reason: Exclude<RunLiveViewEndReason, "closed" | "run-ended"> }
    | { kind: "failed" };

  export let port: Pick<OctopusBeakApi["automation"], "openLiveView" | "closeLiveView" | "onLiveViewFrame" | "onLiveViewEnded">;
  export let taskId: string;
  export let runId: string;
  export let taskLabel: string;
  /** The run's current step, as its card names it. */
  export let step: string;
  export let onClose: () => void;
  export let view: LiveViewState = { kind: "opening" };

  let viewId: string | null = null;
  let destroyed = false;
  /** The newest frame that arrived before the open call answered, so a still page is not left blank. */
  let early: RunLiveViewFrame | null = null;
  const stops: Array<() => void> = [];

  onMount(() => {
    stops.push(port.onLiveViewFrame((frame) => {
      if (viewId === null) early = frame;
      else if (frame.viewId === viewId) view = { kind: "live", viewId, frame };
    }));
    stops.push(port.onLiveViewEnded((end) => {
      if (end.viewId !== viewId) return;
      viewId = null;
      // The run ended or main closed the view: nothing is left to watch.
      if (end.reason === "run-ended" || end.reason === "closed") onClose();
      else view = { kind: "ended", reason: end.reason };
    }));
    port.openLiveView(taskId, runId).then((opened) => {
      if (destroyed) {
        void port.closeLiveView(opened.viewId);
        return;
      }
      viewId = opened.viewId;
      view = { kind: "live", viewId, frame: early?.viewId === viewId ? early : null };
      early = null;
    }, () => {
      if (!destroyed) view = { kind: "failed" };
    });
  });

  onDestroy(() => {
    destroyed = true;
    for (const stop of stops) stop();
    if (viewId !== null) void port.closeLiveView(viewId);
    viewId = null;
    early = null;
  });

  $: copy = $t.automation.liveView;
  $: message = view.kind === "failed"
    ? copy.unavailable
    : view.kind === "ended"
      ? view.reason === "page-closed" ? copy.pageClosed : view.reason === "replaced" ? copy.replaced : copy.unavailable
      : copy.connecting;
</script>

<Modal
  titleId="run-live-view-title"
  title={copy.title(taskLabel)}
  subtitle={copy.readOnly}
  width="min(960px, 100%)"
  {onClose}
>
  <div class="modal-body live-view-body">
    <p class="live-view-step">{copy.currentStep(step)}</p>
    <div class="live-view-stage">
      {#if view.kind === "live" && view.frame}
        <img
          class="live-view-frame"
          src={`data:image/jpeg;base64,${view.frame.data}`}
          alt={copy.frameAlt(taskLabel)}
          width={view.frame.width}
          height={view.frame.height}
          draggable="false"
        />
      {:else}
        <p class="live-view-status" role="status">{message}</p>
      {/if}
    </div>
    <div class="live-view-actions">
      <button class="button secondary" type="button" onclick={onClose}>{$t.common.close}</button>
    </div>
  </div>
</Modal>

<style>
  .live-view-body {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-5);
  }

  .live-view-step {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
  }

  .live-view-stage {
    display: grid;
    place-items: center;
    min-height: 240px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg);
  }

  .live-view-frame {
    display: block;
    width: 100%;
    height: auto;
    pointer-events: none;
    user-select: none;
  }

  .live-view-status {
    margin: 0;
    padding: var(--space-5);
    color: var(--muted);
    font-size: 13px;
    text-align: center;
  }

  .live-view-actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
