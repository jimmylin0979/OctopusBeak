<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import Modal from "$lib/shared-shell/components/Modal.svelte";
  import type { OctopusBeakApi } from "$lib/desktop/api.ts";
  import { t } from "$lib/i18n/i18n.ts";
  import type {
    RunInterventionInput,
    RunInterventionState,
    RunLiveViewEndReason,
    RunLiveViewFrame,
  } from "./run-intervention.ts";

  /** What the dialog shows; frames stay in this component's memory and nowhere else (ADR 0147). */
  type LiveViewState =
    | { kind: "opening" }
    | { kind: "live"; viewId: string; frame: RunLiveViewFrame | null }
    | { kind: "ended"; reason: Exclude<RunLiveViewEndReason, "closed" | "run-ended"> }
    | { kind: "failed" };

  export let port: Pick<
    OctopusBeakApi["automation"],
    | "openLiveView"
    | "closeLiveView"
    | "onLiveViewFrame"
    | "onLiveViewEnded"
    | "takeOverRun"
    | "handBackRun"
    | "giveUpRun"
    | "interventionInput"
  >;
  export let taskId: string;
  export let runId: string;
  export let taskLabel: string;
  /** The run's current step, as its card names it. */
  export let step: string;
  export let onClose: () => void;
  export let view: LiveViewState = { kind: "opening" };
  /** The run's Run intervention as the runtime reports it, or null. */
  export let intervention: RunInterventionState | null = null;
  /** A Verification Stage is open: the person may only watch (ADR 0039). */
  export let verifying = false;

  let viewId: string | null = null;
  let destroyed = false;
  /** The newest frame that arrived before the open call answered, so a still page is not left blank. */
  let early: RunLiveViewFrame | null = null;
  /** Why the last action did not happen, shown until the next one. */
  let notice: string | null = null;
  let busy = false;
  /** Where a press began, so its release is a click or a drag. */
  let pressedAt: { x: number; y: number } | null = null;
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
  $: liveFrame = view.kind === "live" ? view.frame : null;
  /** Input reaches the page only once the run has paused for the person. */
  $: controlling = intervention === "paused" && view.kind === "live";
  $: waiting = intervention === "requested";
  /** Paused behind another run's intervention: watched read-only until its turn (ADR 0147). */
  $: queued = intervention === "waiting";

  async function act(action: (viewId: string) => Promise<unknown>) {
    if (view.kind !== "live" || busy) return;
    busy = true;
    notice = null;
    try {
      await action(view.viewId);
    } catch {
      notice = copy.failed;
    } finally {
      busy = false;
    }
  }

  const takeOver = () => act(async (id) => {
    const result = await port.takeOverRun(id);
    if (!result.ok) notice = copy.refused[result.refused];
  });
  const handBack = () => act((id) => port.handBackRun(id));
  const giveUp = () => act((id) => port.giveUpRun(id));

  /** One action on the paused page; never kept, logged or sent while not controlling. */
  function send(input: RunInterventionInput) {
    if (!controlling || view.kind !== "live") return;
    port.interventionInput(view.viewId, input).catch(() => {
      notice = copy.failed;
    });
  }

  /** The point on the page, in its CSS pixels, under the pointer. */
  function pagePoint(event: PointerEvent) {
    const frame = liveFrame;
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (!frame || box.width === 0 || box.height === 0) return null;
    return {
      x: Math.max(0, ((event.clientX - box.left) * frame.width) / box.width),
      y: Math.max(0, ((event.clientY - box.top) * frame.height) / box.height),
    };
  }

  const DRAG_PX = 4;

  function onPress(event: PointerEvent) {
    if (event.button !== 0) return;
    (event.currentTarget as HTMLElement).focus();
    pressedAt = pagePoint(event);
  }

  function onRelease(event: PointerEvent) {
    const from = pressedAt;
    pressedAt = null;
    const to = pagePoint(event);
    if (!from || !to) return;
    if (Math.hypot(to.x - from.x, to.y - from.y) < DRAG_PX) send({ type: "click", x: from.x, y: from.y });
    else send({ type: "drag", x: from.x, y: from.y, toX: to.x, toY: to.y });
  }

  // Tab is left out on purpose: the control must never trap the keyboard.
  const NAMED_KEYS = new Set(["Enter", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

  function onKey(event: KeyboardEvent) {
    // An input method's own keystrokes are not the text; it reports that when the composition ends.
    if (event.isComposing) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!NAMED_KEYS.has(event.key) && [...event.key].length !== 1) return;
    event.preventDefault();
    send({ type: "press", key: event.key });
  }

  /** Text an input method composed, such as Chinese, is typed whole rather than key by key. */
  function onComposed(event: CompositionEvent) {
    if (event.data) send({ type: "type", text: event.data });
  }
</script>

<Modal
  titleId="run-live-view-title"
  title={copy.title(taskLabel)}
  subtitle={controlling ? copy.controlling : copy.readOnly}
  width="min(960px, 100%)"
  {onClose}
  closable={!controlling}
>
  <div class="modal-body live-view-body">
    <p class="live-view-step">{copy.currentStep(step)}</p>
    <div class="live-view-stage">
      {#if controlling}
        {#if liveFrame}
          <button
            class="live-view-control"
            type="button"
            aria-label={copy.controlLabel(taskLabel)}
            onpointerdown={onPress}
            onpointerup={onRelease}
            onkeydown={onKey}
            oncompositionend={onComposed}
          >
            <img
              class="live-view-frame"
              src={`data:image/jpeg;base64,${liveFrame.data}`}
              alt=""
              width={liveFrame.width}
              height={liveFrame.height}
              draggable="false"
            />
          </button>
        {:else}
          <p class="live-view-status" role="status">{copy.connecting}</p>
        {/if}
      {:else if liveFrame}
        <img
          class="live-view-frame"
          src={`data:image/jpeg;base64,${liveFrame.data}`}
          alt={copy.frameAlt(taskLabel)}
          width={liveFrame.width}
          height={liveFrame.height}
          draggable="false"
        />
      {:else}
        <p class="live-view-status" role="status">{message}</p>
      {/if}
    </div>
    {#if waiting}
      <p class="live-view-note" role="status">{copy.waiting}</p>
    {:else if queued}
      <p class="live-view-note" role="status">{copy.queued}</p>
    {:else if verifying && !controlling}
      <p class="live-view-note">{copy.verifying}</p>
    {/if}
    {#if notice}
      <p class="live-view-note" role="alert">{notice}</p>
    {/if}
    <div class="live-view-actions">
      {#if controlling}
        <button class="button danger" type="button" disabled={busy} onclick={giveUp}>{copy.giveUp}</button>
        <button class="button primary" type="button" disabled={busy} onclick={handBack}>{copy.handBack}</button>
      {:else}
        {#if view.kind === "live"}
          <button class="button secondary" type="button" disabled={busy || waiting || queued || verifying} onclick={takeOver}>{copy.takeOver}</button>
        {/if}
        <button class="button secondary" type="button" onclick={onClose}>{$t.common.close}</button>
      {/if}
    </div>
  </div>
</Modal>

<style>
  .live-view-body {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-5);
  }

  .live-view-step,
  .live-view-note {
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

  .live-view-control {
    display: block;
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
    touch-action: none;
  }

  .live-view-control:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
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
    gap: var(--space-2);
  }
</style>
