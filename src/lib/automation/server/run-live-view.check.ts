import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { Page } from "playwright";
import { createPgliteOperationalProvider } from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";
import { createDataVersionStore } from "../../shared-shell/data-version.ts";
import { openActiveTaskRun, type ActiveAutomationTaskRun } from "./active-task-run.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import type { AutomationPersistencePort } from "./store.ts";
import {
  createRunLiveView,
  type LiveViewCdpSession,
  type RunLiveViewEnd,
  type RunLiveViewFrame,
  type RunLiveViewSink,
} from "./run-live-view.ts";

const database = await createTestPGlite("operational");
after(() => database.close());
const provider = createPgliteOperationalProvider(new PGliteStore(database));

/** Every argument any persistence method received, so a check can search what reached storage. */
const persisted: string[] = [];
const persistence = new Proxy(provider.automation, {
  get(target, property, receiver) {
    const member = Reflect.get(target, property, receiver);
    if (typeof member !== "function") return member;
    return (...args: unknown[]) => {
      persisted.push(JSON.stringify(args));
      return (member as (...input: unknown[]) => unknown).apply(target, args);
    };
  },
}) as AutomationPersistencePort;

async function openRun(options: { scheduledAtUtc?: string } = {}) {
  const { taskRunId } = await persistence.createTaskRun({
    taskId: "sinopac-statements",
    kind: "crawler",
    status: "preparing",
    attempt: 1,
    maxAttempts: 1,
    startedAt: new Date().toISOString(),
    ...(options.scheduledAtUtc ? { scheduledAtUtc: options.scheduledAtUtc } : {}),
  });
  const run = openActiveTaskRun({
    run: (await persistence.taskRunById(taskRunId))!,
    persistence,
    runtime: createAutomationRuntimeState(),
    dataVersionStore: createDataVersionStore(),
  });
  await run.transition("running");
  return run;
}

type FakeCdp = LiveViewCdpSession & {
  sent: Array<[string, unknown]>;
  detached: boolean;
  /** The browser paints a frame. */
  paint(data: string, sessionId?: number): void;
};

function fakePage() {
  const listeners = new Map<string, Set<() => void>>();
  const sessions: FakeCdp[] = [];
  const page = {
    on(event: string, listener: () => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return page;
    },
    off(event: string, listener: () => void) {
      listeners.get(event)?.delete(listener);
      return page;
    },
  };
  return {
    page: page as unknown as Page,
    sessions,
    close() {
      for (const listener of listeners.get("close") ?? []) listener();
    },
    async openCdpSession(): Promise<FakeCdp> {
      let onFrame: ((event: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => void) | null = null;
      const session: FakeCdp = {
        sent: [],
        detached: false,
        async send(method, params) {
          session.sent.push([method, params]);
          return {};
        },
        on(event, listener) {
          if (event === "Page.screencastFrame") onFrame = listener;
        },
        async detach() {
          session.detached = true;
        },
        paint(data, sessionId = 1) {
          onFrame?.({ data, sessionId, metadata: { deviceWidth: 1280, deviceHeight: 800 } });
        },
      };
      sessions.push(session);
      return session;
    },
  };
}

function recordingSink() {
  const frames: RunLiveViewFrame[] = [];
  const ends: RunLiveViewEnd[] = [];
  const sink: RunLiveViewSink = { frame: (frame) => frames.push(frame), ended: (end) => ends.push(end) };
  return { sink, frames, ends };
}

/** A live view over these runs, each hosting its own fake page in its current execution. */
function liveViewOver(...runs: ActiveAutomationTaskRun[]) {
  const pages = new Map<string, ReturnType<typeof fakePage>>();
  for (const run of runs) {
    const page = fakePage();
    pages.set(run.taskRunId, page);
    run.beginExecution(`${run.taskRunId}-round-1`).hostPage({ page: page.page });
  }
  const liveView = createRunLiveView({
    activeRun: (taskRunId) => runs.find((run) => run.taskRunId === taskRunId) ?? null,
    openCdpSession: (page) => [...pages.values()].find((candidate) => candidate.page === page)!.openCdpSession(),
  });
  return { liveView, pages };
}

const methods = (session: FakeCdp) => session.sent.map(([method]) => method);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a view streams the run's page frames with its view id and acknowledges each one", async () => {
  const run = await openRun();
  const { liveView, pages } = liveViewOver(run);
  const { sink, frames } = recordingSink();

  const { viewId } = await liveView.open(run.taskId, run.taskRunId, sink);
  const [session] = pages.get(run.taskRunId)!.sessions;
  assert.equal(methods(session!)[0], "Page.startScreencast");
  session!.paint("frame-one", 7);
  await tick();

  assert.deepEqual(frames, [{ viewId, runId: run.taskRunId, data: "frame-one", width: 1280, height: 800 }]);
  assert.deepEqual(session!.sent.at(-1), ["Page.screencastFrameAck", { sessionId: 7 }]);
  await liveView.closeAll();
  await run.finish({ summary: null, failure: null });
});

test("opening a second view ends the first, so one screencast runs at a time", async () => {
  const first = await openRun();
  const second = await openRun();
  const { liveView, pages } = liveViewOver(first, second);
  const one = recordingSink();
  const two = recordingSink();

  const opened = await liveView.open(first.taskId, first.taskRunId, one.sink);
  const replacing = await liveView.open(second.taskId, second.taskRunId, two.sink);
  const [firstSession] = pages.get(first.taskRunId)!.sessions;
  const [secondSession] = pages.get(second.taskRunId)!.sessions;

  assert.deepEqual(one.ends, [{ viewId: opened.viewId, reason: "replaced" }]);
  assert.ok(methods(firstSession!).includes("Page.stopScreencast"));
  assert.equal(firstSession!.detached, true);
  assert.equal(secondSession!.detached, false);
  firstSession!.paint("stale");
  secondSession!.paint("fresh");
  await tick();
  assert.deepEqual(one.frames, [], "the replaced view hears no more frames");
  assert.deepEqual(two.frames.map((frame) => frame.viewId), [replacing.viewId]);

  await liveView.closeAll();
  await first.finish({ summary: null, failure: null });
  await second.finish({ summary: null, failure: null });
});

test("closing the view stops the screencast and ignores a stale close", async () => {
  const run = await openRun();
  const { liveView, pages } = liveViewOver(run);
  const { sink, frames, ends } = recordingSink();

  const { viewId } = await liveView.open(run.taskId, run.taskRunId, sink);
  await liveView.close("another-view");
  const [session] = pages.get(run.taskRunId)!.sessions;
  assert.equal(session!.detached, false, "a close for another view leaves this one open");
  await liveView.close(viewId);

  assert.ok(methods(session!).includes("Page.stopScreencast"));
  assert.equal(session!.detached, true);
  assert.deepEqual(ends, [{ viewId, reason: "closed" }]);
  session!.paint("after-close");
  await tick();
  assert.deepEqual(frames, []);
  await run.finish({ summary: null, failure: null });
});

test("the run's end stops the screencast and ends the view", async () => {
  const run = await openRun();
  const { liveView, pages } = liveViewOver(run);
  const { sink, ends } = recordingSink();

  const { viewId } = await liveView.open(run.taskId, run.taskRunId, sink);
  await run.finish({ summary: null, failure: null });
  await tick();
  const [session] = pages.get(run.taskRunId)!.sessions;

  assert.deepEqual(ends, [{ viewId, reason: "run-ended" }]);
  assert.equal(session!.detached, true);
  const stored = await persistence.taskRunById(run.taskRunId);
  assert.deepEqual(stored?.interventionLog?.map((entry) => entry.action), ["view-opened", "view-closed"]);
  await liveView.closeAll();
});

test("the page closing, as between CAPTCHA rounds, ends the view", async () => {
  const run = await openRun();
  const { liveView, pages } = liveViewOver(run);
  const { sink, ends } = recordingSink();

  const { viewId } = await liveView.open(run.taskId, run.taskRunId, sink);
  pages.get(run.taskRunId)!.close();
  await tick();

  assert.deepEqual(ends, [{ viewId, reason: "page-closed" }]);
  assert.equal(pages.get(run.taskRunId)!.sessions[0]!.detached, true);
  await liveView.closeAll();
  await run.finish({ summary: null, failure: null });
});

test("a view whose window is gone stops at the next frame", async () => {
  const run = await openRun();
  const { liveView, pages } = liveViewOver(run);
  let gone = false;
  const frames: RunLiveViewFrame[] = [];
  await liveView.open(run.taskId, run.taskRunId, {
    frame: (frame) => frames.push(frame),
    ended: () => {},
    gone: () => gone,
  });
  gone = true;
  const [session] = pages.get(run.taskRunId)!.sessions;
  session!.paint("nobody-watching");
  await tick();

  assert.deepEqual(frames, []);
  assert.equal(session!.detached, true);
  await liveView.closeAll();
  await run.finish({ summary: null, failure: null });
});

test("only a running manual run with a page can be watched", async () => {
  const scheduled = await openRun({ scheduledAtUtc: "2026-11-22T01:00:00.000Z" });
  const pageless = await openRun();
  const manual = await openRun();
  const { liveView } = liveViewOver(scheduled, manual);
  const liveViewWithoutPage = createRunLiveView({
    activeRun: (taskRunId) => (taskRunId === pageless.taskRunId ? pageless : null),
    openCdpSession: () => Promise.reject(new Error("no page to attach to")),
  });
  const { sink } = recordingSink();

  await assert.rejects(liveView.open(scheduled.taskId, scheduled.taskRunId, sink), /manual/u);
  await assert.rejects(liveView.open(manual.taskId, "unknown-run", sink), /not running/u);
  await assert.rejects(liveView.open("another-task", manual.taskRunId, sink), /not running/u);
  await assert.rejects(liveViewWithoutPage.open(pageless.taskId, pageless.taskRunId, sink), /no browser page/u);
  await manual.finish({ summary: null, failure: null });
  await assert.rejects(liveView.open(manual.taskId, manual.taskRunId, sink), /not running/u, "a finished run cannot be watched");

  await liveView.closeAll();
  await liveViewWithoutPage.closeAll();
  await scheduled.finish({ summary: null, failure: null });
  await pageless.finish({ summary: null, failure: null });
});

test("the view sends no input to the page and offers no way to", async () => {
  const run = await openRun();
  const { liveView, pages } = liveViewOver(run);
  const { sink } = recordingSink();

  const { viewId } = await liveView.open(run.taskId, run.taskRunId, sink);
  const [session] = pages.get(run.taskRunId)!.sessions;
  session!.paint("frame");
  await tick();
  await liveView.close(viewId);

  assert.deepEqual(Object.keys(liveView).sort(), ["close", "closeAll", "open"]);
  for (const method of methods(session!)) {
    assert.ok(
      ["Page.startScreencast", "Page.screencastFrameAck", "Page.stopScreencast"].includes(method),
      `${method} is not a screencast call`,
    );
  }
  await run.finish({ summary: null, failure: null });
});

test("frames live only in memory: no persisted record or log holds one", async () => {
  const sentinel = "SENTINELFRAMEBYTES/9j/4AAQSkZJRg==";
  const logged: string[] = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const level of Object.keys(originals) as Array<keyof typeof originals>) {
    console[level] = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  }
  persisted.length = 0;
  try {
    const run = await openRun();
    const { liveView, pages } = liveViewOver(run);
    const { sink, frames } = recordingSink();
    const { viewId } = await liveView.open(run.taskId, run.taskRunId, sink);
    pages.get(run.taskRunId)!.sessions[0]!.paint(sentinel);
    await tick();
    await liveView.close(viewId);
    await run.finish({ summary: null, failure: null });

    assert.equal(frames[0]?.data, sentinel, "the frame reached the open view");
    const stored = await persistence.taskRunById(run.taskRunId);
    assert.deepEqual(stored?.interventionLog?.map((entry) => entry.action), ["view-opened", "view-closed"]);
    assert.ok(persisted.length > 0);
    for (const write of persisted) assert.ok(!write.includes(sentinel), "no persistence call carries frame bytes");
    assert.ok(!stored!.recordJson.includes(sentinel));
    for (const line of logged) assert.ok(!line.includes(sentinel), "no log line carries frame bytes");
  } finally {
    Object.assign(console, originals);
  }
});
