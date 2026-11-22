import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { ActiveAutomationTaskRun } from "./active-task-run.ts";
import { isTerminalTaskRunStatus } from "./store.ts";
import { onTaskRunFinished } from "./task-run-finished.ts";
import type { RunLiveViewEnd, RunLiveViewEndReason, RunLiveViewFrame, TakeOverResult } from "../run-intervention.ts";
import { normalizeViewerInput, type ViewerInput } from "./automation-viewer.ts";

export type { RunLiveViewEnd, RunLiveViewEndReason, RunLiveViewFrame } from "../run-intervention.ts";

/** Where one view's frames go: the window that opened it. */
export type RunLiveViewSink = Readonly<{
  frame(frame: RunLiveViewFrame): void;
  ended(end: RunLiveViewEnd): void;
  /** True once the receiver can take no more frames, such as a closed window. */
  gone?(): boolean;
}>;

type ScreencastFrameEvent = Readonly<{
  data: string;
  sessionId: number;
  metadata: Readonly<{ deviceWidth: number; deviceHeight: number }>;
}>;

/** The part of a Chrome DevTools Protocol session the live view uses. */
export type LiveViewCdpSession = Readonly<{
  send(method: string, params?: object): Promise<unknown>;
  on(event: "Page.screencastFrame", listener: (frame: ScreencastFrameEvent) => void): unknown;
  detach(): Promise<void>;
}>;

export type RunLiveViewDeps = Readonly<{
  /** The Active Automation Task Run with this id, or null. */
  activeRun(taskRunId: string): ActiveAutomationTaskRun | null;
  /** A CDP session on the page; Playwright's own by default. */
  openCdpSession?(page: Page): Promise<LiveViewCdpSession>;
}>;

/** Painted at most this large, which is enough to read a dialog and keeps IPC light. */
const SCREENCAST = { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 } as const;

type View = {
  viewId: string;
  run: ActiveAutomationTaskRun;
  page: Page;
  session: LiveViewCdpSession;
  sink: RunLiveViewSink;
  release(): void;
};

/** The named keys a person may press, as Chrome's key events name them. */
const NAMED_KEYS: Readonly<Record<string, Readonly<{ code: string; windowsVirtualKeyCode: number; text?: string }>>> = {
  Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
  Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { code: "Delete", windowsVirtualKeyCode: 46 },
  Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
  ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
};

/** The CDP calls that perform one normalized action, in page CSS pixels. */
function cdpInput(input: ViewerInput): Array<[string, object]> {
  const button = { button: "left", clickCount: 1 } as const;
  switch (input.type) {
    case "click":
      return [
        ["Input.dispatchMouseEvent", { type: "mouseMoved", x: input.x, y: input.y }],
        ["Input.dispatchMouseEvent", { type: "mousePressed", x: input.x, y: input.y, ...button }],
        ["Input.dispatchMouseEvent", { type: "mouseReleased", x: input.x, y: input.y, ...button }],
      ];
    case "drag":
      return [
        ["Input.dispatchMouseEvent", { type: "mouseMoved", x: input.x, y: input.y }],
        ["Input.dispatchMouseEvent", { type: "mousePressed", x: input.x, y: input.y, ...button }],
        ["Input.dispatchMouseEvent", { type: "mouseMoved", x: input.toX, y: input.toY, button: "left", buttons: 1 }],
        ["Input.dispatchMouseEvent", { type: "mouseReleased", x: input.toX, y: input.toY, ...button }],
      ];
    case "type":
      return [["Input.insertText", { text: input.text }]];
    case "press": {
      const named = NAMED_KEYS[input.key];
      if (!named) {
        return [
          ["Input.dispatchKeyEvent", { type: "keyDown", key: input.key, text: input.key }],
          ["Input.dispatchKeyEvent", { type: "keyUp", key: input.key }],
        ];
      }
      const { text, ...key } = named;
      return [
        ["Input.dispatchKeyEvent", text ? { type: "keyDown", key: input.key, ...key, text } : { type: "rawKeyDown", key: input.key, ...key }],
        ["Input.dispatchKeyEvent", { type: "keyUp", key: input.key, ...key }],
      ];
    }
  }
}

const defaultCdpSession = (page: Page) =>
  page.context().newCDPSession(page) as unknown as Promise<LiveViewCdpSession>;

/**
 * The App's Run live view (ADR 0147): a read-only CDP screencast of the page
 * an Active run already holds. At most one view is open; opening another ends
 * it. Frames go only to the open view's sink and stop when it closes, the
 * run ends or the page closes. While the person watches it sends the page
 * screencast calls only; pointer and key input reaches the page only while
 * the watched run is paused in a Run intervention.
 */
export function createRunLiveView(deps: RunLiveViewDeps) {
  const openCdpSession = deps.openCdpSession ?? defaultCdpSession;
  let current: View | null = null;
  // Opens and ends run one after another, so two opens never both start a screencast.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };

  async function end(view: View, reason: RunLiveViewEndReason) {
    if (current !== view) return;
    current = null;
    view.release();
    if (!view.sink.gone?.()) view.sink.ended({ viewId: view.viewId, reason });
    await view.session.send("Page.stopScreencast").catch(() => undefined);
    await view.session.detach().catch(() => undefined);
    await view.run.recordIntervention("view-closed")
      .catch(() => console.error("run-live-view-record-failed"));
  }

  function watched(taskId: string, taskRunId: string) {
    const run = deps.activeRun(taskRunId);
    if (!run || run.taskId !== taskId || isTerminalTaskRunStatus(run.current().status)) {
      throw new Error(`Automation task run is not running: ${taskId}`);
    }
    if (run.trigger !== "manual") throw new Error("Only a manual run offers a live view.");
    const page = run.currentExecution()?.page() ?? null;
    if (!page) throw new Error("The run has no browser page to show yet.");
    return { run, page };
  }

  async function start(taskId: string, taskRunId: string, sink: RunLiveViewSink) {
    const { run, page } = watched(taskId, taskRunId);
    if (current) await end(current, "replaced");
    const session = await openCdpSession(page);
    const viewId = randomUUID();
    const onPageClose = () => void serialized(() => end(view, "page-closed"));
    const stopListening = onTaskRunFinished((finished) => {
      if (finished.taskRunId === taskRunId) void serialized(() => end(view, "run-ended"));
    });
    const view: View = {
      viewId,
      run,
      page,
      session,
      sink,
      release() {
        page.off("close", onPageClose);
        stopListening();
      },
    };
    current = view;
    page.on("close", onPageClose);
    session.on("Page.screencastFrame", (event) => {
      if (current !== view) return;
      if (sink.gone?.()) {
        void serialized(() => end(view, "closed"));
        return;
      }
      sink.frame({
        viewId,
        runId: taskRunId,
        data: event.data,
        width: event.metadata.deviceWidth,
        height: event.metadata.deviceHeight,
      });
      void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
    });
    try {
      await run.recordIntervention("view-opened");
      await session.send("Page.startScreencast", SCREENCAST);
    } catch (error) {
      await end(view, "failed");
      throw error;
    }
    return { viewId };
  }

  /** The open view with this id; a call for any other view is refused. */
  function openView(viewId: string): View {
    if (current?.viewId !== viewId) throw new Error("This live view is not open.");
    return current;
  }

  return Object.freeze({
    /** Ask the watched run to pause at its next safe point so the person can take over (ADR 0147). */
    takeOver: async (viewId: string): Promise<TakeOverResult> => await openView(viewId).run.requestTakeOver(),
    /** Resume the watched run from its current step. False when it is not paused. */
    handBack: async (viewId: string): Promise<boolean> => await openView(viewId).run.handBack(),
    /** End the watched, paused run as a cancel. False when it is not paused. */
    giveUp: async (viewId: string): Promise<boolean> => await openView(viewId).run.giveUp(),
    /**
     * Send one pointer or key action to the watched page, normalized by the
     * viewer input rules with printable keys. Refused unless the run is paused
     * in an intervention. The input is never stored or logged.
     */
    async input(viewId: string, raw: unknown): Promise<void> {
      const view = openView(viewId);
      if (view.run.intervention() !== "paused") throw new Error("The run is not paused for you.");
      for (const [method, params] of cdpInput(normalizeViewerInput(raw, { printableKeys: true }))) {
        await view.session.send(method, params);
      }
    },
    /** Open a view of the task's running manual run, ending any other view first. */
    open: (taskId: string, taskRunId: string, sink: RunLiveViewSink): Promise<{ viewId: string }> =>
      serialized(() => start(taskId, taskRunId, sink)),
    /** Close this view; a close for a view already ended does nothing. */
    close: (viewId: string): Promise<void> =>
      serialized(async () => {
        if (current?.viewId === viewId) await end(current, "closed");
      }),
    /** Close whatever view is open, for the App's shutdown. */
    closeAll: (): Promise<void> =>
      serialized(async () => {
        if (current) await end(current, "closed");
      }),
  });
}

export type RunLiveView = ReturnType<typeof createRunLiveView>;
