import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { ActiveAutomationTaskRun } from "./active-task-run.ts";
import { isTerminalTaskRunStatus } from "./store.ts";
import { onTaskRunFinished } from "./task-run-finished.ts";
import type { RunLiveViewEnd, RunLiveViewEndReason, RunLiveViewFrame } from "../run-intervention.ts";

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

const defaultCdpSession = (page: Page) =>
  page.context().newCDPSession(page) as unknown as Promise<LiveViewCdpSession>;

/**
 * The App's Run live view (ADR 0147): a read-only CDP screencast of the page
 * an Active run already holds. At most one view is open; opening another ends
 * it. Frames go only to the open view's sink and stop when it closes, the
 * run ends or the page closes. It sends the page screencast calls only, so
 * nothing the person does reaches the page.
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

  return Object.freeze({
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
