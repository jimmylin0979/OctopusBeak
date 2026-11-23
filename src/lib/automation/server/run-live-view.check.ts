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
import { createRunInterventionQueue, type RunInterventionQueue } from "./run-intervention-queue.ts";

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

async function openRun(options: { scheduledAtUtc?: string; interventionQueue?: RunInterventionQueue } = {}) {
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
    ...(options.interventionQueue ? { interventionQueue: options.interventionQueue } : {}),
  });
  await run.transition("running");
  return run;
}

type FakeCdp = LiveViewCdpSession & {
  sent: Array<[string, unknown]>;
  detached: boolean;
  /** How long each call takes to reach the browser; none by default. */
  sendDelayMs: number;
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
        sendDelayMs: 0,
        async send(method, params) {
          if (session.sendDelayMs) await new Promise((resolve) => setTimeout(resolve, session.sendDelayMs));
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

test("a sink that throws while the view ends still stops the screencast, detaches and records the close", async () => {
  const run = await openRun();
  const { liveView, pages } = liveViewOver(run);
  await liveView.open(run.taskId, run.taskRunId, {
    frame: () => {},
    ended: () => { throw new Error("sender destroyed"); },
  });
  await liveView.closeAll();
  const [session] = pages.get(run.taskRunId)!.sessions;

  assert.equal(methods(session!).includes("Page.stopScreencast"), true);
  assert.equal(session!.detached, true);
  const stored = await persistence.taskRunById(run.taskRunId);
  assert.deepEqual(stored?.interventionLog?.map((entry) => entry.action), ["view-opened", "view-closed"]);
  await run.finish({ summary: null, failure: null });
});

test("a failed send of a frame ends the view instead of streaming into the void", async () => {
  const run = await openRun();
  const { liveView, pages } = liveViewOver(run);
  const ends: RunLiveViewEnd[] = [];
  const { viewId } = await liveView.open(run.taskId, run.taskRunId, {
    frame: () => { throw new Error("render frame disposed"); },
    ended: (end) => ends.push(end),
  });
  const [session] = pages.get(run.taskRunId)!.sessions;
  session!.paint("lost");
  await tick();

  assert.deepEqual(ends, [{ viewId, reason: "closed" }]);
  assert.equal(session!.detached, true);
  await liveView.closeAll();
  await run.finish({ summary: null, failure: null });
});

test("a window that goes away or reloads ends the view even when no frame follows", async () => {
  const run = await openRun();
  const { liveView, pages } = liveViewOver(run);
  const goneListeners = new Set<() => void>();
  const ends: RunLiveViewEnd[] = [];
  const { viewId } = await liveView.open(run.taskId, run.taskRunId, {
    frame: () => {},
    ended: (end) => ends.push(end),
    onGone: (listener) => {
      goneListeners.add(listener);
      return () => goneListeners.delete(listener);
    },
  });
  assert.equal(goneListeners.size, 1);
  for (const listener of goneListeners) listener();
  await tick();
  await tick();

  assert.deepEqual(ends, [{ viewId, reason: "closed" }]);
  assert.equal(pages.get(run.taskRunId)!.sessions[0]!.detached, true);
  assert.equal(goneListeners.size, 0, "the view stops listening once it ends");
  const stored = await persistence.taskRunById(run.taskRunId);
  assert.deepEqual(stored?.interventionLog?.map((entry) => entry.action), ["view-opened", "view-closed"]);
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
    pageWaitMs: 40,
    pagePollMs: 5,
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

test("a view opened while the run's browser is still starting waits for the page instead of failing", async () => {
  const run = await openRun();
  const pageFake = fakePage();
  const liveView = createRunLiveView({
    activeRun: () => run,
    openCdpSession: () => pageFake.openCdpSession(),
    pageWaitMs: 2_000,
    pagePollMs: 5,
  });
  const { sink, frames } = recordingSink();

  // A cold Chromium launch: the execution exists, its page does not yet.
  const execution = run.beginExecution(`${run.taskRunId}-round-1`);
  const opening = liveView.open(run.taskId, run.taskRunId, sink);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(pageFake.sessions.length, 0, "nothing is attached before the page exists");
  execution.hostPage({ page: pageFake.page });

  const { viewId } = await opening;
  const [session] = pageFake.sessions;
  assert.equal(methods(session!)[0], "Page.startScreencast");
  session!.paint("late-frame");
  await tick();
  assert.deepEqual(frames.map((frame) => [frame.viewId, frame.data]), [[viewId, "late-frame"]]);
  await liveView.closeAll();
  await run.finish({ summary: null, failure: null });
});

test("a view still waiting for the page gives up when the run ends or the wait is spent", async () => {
  const run = await openRun();
  const liveView = createRunLiveView({
    activeRun: () => run,
    openCdpSession: () => Promise.reject(new Error("no page to attach to")),
    pageWaitMs: 2_000,
    pagePollMs: 5,
  });
  const { sink } = recordingSink();
  run.beginExecution(`${run.taskRunId}-round-1`);

  const opening = liveView.open(run.taskId, run.taskRunId, sink);
  const refused = assert.rejects(opening, /not running/u);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await run.finish({ summary: null, failure: null });
  await refused;
});

const SCREENCAST_CALLS = ["Page.startScreencast", "Page.screencastFrameAck", "Page.stopScreencast"];

test("a watching view sends no input to the page: only screencast calls reach it", async () => {
  const run = await openRun();
  const { liveView, pages } = liveViewOver(run);
  const { sink } = recordingSink();

  const { viewId } = await liveView.open(run.taskId, run.taskRunId, sink);
  const [session] = pages.get(run.taskRunId)!.sessions;
  session!.paint("frame");
  await tick();
  await assert.rejects(liveView.input(viewId, { type: "click", x: 10, y: 10 }), /not paused/u);
  await liveView.close(viewId);

  for (const method of methods(session!)) assert.ok(SCREENCAST_CALLS.includes(method), `${method} is not a screencast call`);
  await run.finish({ summary: null, failure: null });
});

const inputCalls = (session: FakeCdp) => session.sent.filter(([method]) => !SCREENCAST_CALLS.includes(method));

test("input reaches the page only while the run is paused for the person, normalized by the viewer input rules", async () => {
  const run = await openRun();
  const { liveView, pages } = liveViewOver(run);
  const { sink } = recordingSink();
  const { viewId } = await liveView.open(run.taskId, run.taskRunId, sink);
  const [session] = pages.get(run.taskRunId)!.sessions;
  const click = { type: "click", x: 40.4, y: 20.6 };

  assert.deepEqual(await liveView.takeOver(viewId), { ok: true });
  await assert.rejects(liveView.input(viewId, click), /not paused/u, "waiting for the current step, input is refused");
  assert.deepEqual(inputCalls(session!), []);

  const paused = run.interventionSafePoint(run.signal);
  await tick();
  await liveView.input(viewId, click);
  await liveView.input(viewId, { type: "type", text: "hello" });
  await liveView.input(viewId, { type: "press", key: "Escape" });
  await liveView.input(viewId, { type: "press", key: "x" });
  await assert.rejects(liveView.input(viewId, { type: "press", key: "Meta+R" }), /Unsupported viewer input/u);
  await assert.rejects(liveView.input(viewId, { type: "click", x: -5, y: 0 }), /Unsupported viewer input/u);
  await assert.rejects(liveView.input("another-view", click), /not open/u);
  assert.deepEqual(inputCalls(session!), [
    ["Input.dispatchMouseEvent", { type: "mouseMoved", x: 40, y: 21 }],
    ["Input.dispatchMouseEvent", { type: "mousePressed", x: 40, y: 21, button: "left", clickCount: 1 }],
    ["Input.dispatchMouseEvent", { type: "mouseReleased", x: 40, y: 21, button: "left", clickCount: 1 }],
    ["Input.insertText", { text: "hello" }],
    ["Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }],
    ["Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }],
    ["Input.dispatchKeyEvent", { type: "keyDown", key: "x", text: "x" }],
    ["Input.dispatchKeyEvent", { type: "keyUp", key: "x" }],
  ]);

  assert.equal(await liveView.handBack(viewId), true);
  assert.equal(await paused, "handed-back");
  await assert.rejects(liveView.input(viewId, click), /not paused/u, "after Hand back, input is refused again");
  assert.equal(inputCalls(session!).length, 8);
  await liveView.closeAll();
  await run.finish({ summary: null, failure: null });
});

test("keys sent without waiting for each other reach the page whole and in order", async () => {
  const run = await openRun();
  const { liveView, pages } = liveViewOver(run);
  const { sink } = recordingSink();
  const { viewId } = await liveView.open(run.taskId, run.taskRunId, sink);
  const [session] = pages.get(run.taskRunId)!.sessions;
  assert.deepEqual(await liveView.takeOver(viewId), { ok: true });
  const paused = run.interventionSafePoint(run.signal);
  await tick();

  // Each CDP call takes a moment, as it does in a real browser.
  session!.sendDelayMs = 2;
  const before = session!.sent.length;
  // A person typing quickly: the renderer does not wait for one key before sending the next.
  await Promise.all(["e", "e", "r"].map((key) => liveView.input(viewId, { type: "press", key })));

  assert.deepEqual(
    session!.sent.slice(before).map(([, params]) => {
      const event = params as { type: string; key: string };
      return `${event.type}:${event.key}`;
    }),
    ["keyDown:e", "keyUp:e", "keyDown:e", "keyUp:e", "keyDown:r", "keyUp:r"],
    "a key's down and up are never interleaved with the next key's",
  );

  assert.equal(await liveView.handBack(viewId), true);
  assert.equal(await paused, "handed-back");
  await liveView.closeAll();
  await run.finish({ summary: null, failure: null });
});

test("a run waiting for you behind another shows its page read-only and refuses input until its turn", async () => {
  const interventionQueue = createRunInterventionQueue();
  const active = await openRun({ interventionQueue });
  const waiting = await openRun({ interventionQueue });
  const { liveView, pages } = liveViewOver(active, waiting);
  const pausedActive = active.interventionSafePoint(active.signal, "deadline");
  const pausedWaiting = waiting.interventionSafePoint(waiting.signal, "deadline");
  await tick();
  assert.equal(waiting.intervention(), "waiting");

  const { sink, frames } = recordingSink();
  const { viewId } = await liveView.open(waiting.taskId, waiting.taskRunId, sink);
  const [session] = pages.get(waiting.taskRunId)!.sessions;
  session!.paint("frame-1");
  assert.equal(frames.length, 1, "the person can watch the waiting run's page");
  const click = { type: "click", x: 10, y: 10 };
  await assert.rejects(liveView.input(viewId, click), /not paused/u, "a waiting run refuses input");
  assert.equal(await liveView.handBack(viewId), false, "a waiting run has nothing to hand back yet");
  assert.deepEqual(inputCalls(session!), []);

  assert.equal(await active.handBack(), true);
  assert.equal(await pausedActive, "handed-back");
  assert.equal(waiting.intervention(), "paused", "its turn came");
  await liveView.input(viewId, click);
  assert.equal(inputCalls(session!).length, 3, "now the person controls its page");
  assert.equal(await liveView.handBack(viewId), true);
  assert.equal(await pausedWaiting, "handed-back");
  await liveView.closeAll();
  for (const run of [active, waiting]) {
    run.currentExecution()?.end();
    await run.finish({ summary: null, failure: null });
  }
});

test("the view's Take over is refused while verifying, and Give up ends the paused run as a cancel", async () => {
  const run = await openRun();
  const { liveView } = liveViewOver(run);
  const { sink, ends } = recordingSink();
  const { viewId } = await liveView.open(run.taskId, run.taskRunId, sink);

  await run.transition("waiting_for_human");
  assert.deepEqual(await liveView.takeOver(viewId), { ok: false, refused: "verifying" });
  await run.transition("running");
  await assert.rejects(liveView.takeOver("another-view"), /not open/u);
  assert.equal(await liveView.giveUp(viewId), false, "nothing is paused to give up");

  await liveView.takeOver(viewId);
  const paused = run.interventionSafePoint(run.signal);
  await tick();
  assert.equal(await liveView.giveUp(viewId), true);
  assert.equal(await paused, "given-up");
  assert.equal(run.stopReason(), "cancelled");
  await run.finish({ summary: null, failure: { code: "cancelled", proven: true } });
  await tick();
  assert.deepEqual(ends.map((end) => end.reason), ["run-ended"]);
  await liveView.closeAll();
});

test("nothing the person types during an intervention reaches persistence or a log", async () => {
  const sentinel = "SENTINELPASSWORD-hunter2";
  const logged: string[] = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const level of Object.keys(originals) as Array<keyof typeof originals>) {
    console[level] = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  }
  persisted.length = 0;
  try {
    const run = await openRun();
    const { liveView, pages } = liveViewOver(run);
    const { sink } = recordingSink();
    const { viewId } = await liveView.open(run.taskId, run.taskRunId, sink);
    await liveView.takeOver(viewId);
    const paused = run.interventionSafePoint(run.signal);
    await tick();
    await liveView.input(viewId, { type: "type", text: sentinel });
    await liveView.input(viewId, { type: "press", key: "S" }).catch(() => undefined);
    await liveView.input(viewId, { type: "type", text: `${sentinel}${"x".repeat(200)}` }).catch(() => undefined);
    await liveView.handBack(viewId);
    await paused;
    await liveView.close(viewId);
    await run.finish({ summary: null, failure: null });

    assert.deepEqual(inputCalls(pages.get(run.taskRunId)!.sessions[0]!)[0], ["Input.insertText", { text: sentinel }], "the input reached the page");
    const stored = await persistence.taskRunById(run.taskRunId);
    assert.deepEqual(stored?.interventionLog?.map((entry) => entry.action), [
      "view-opened", "take-over", "paused", "handed-back", "view-closed",
    ]);
    for (const entry of stored?.interventionLog ?? []) assert.deepEqual(Object.keys(entry).sort(), ["action", "at"]);
    for (const event of stored?.events ?? []) assert.equal(event.stoppedAt, undefined);
    for (const write of persisted) assert.ok(!write.includes(sentinel), "no persistence call carries the input");
    assert.ok(!stored!.recordJson.includes(sentinel));
    assert.ok(!JSON.stringify(stored!.events).includes(sentinel));
    for (const line of logged) assert.ok(!line.includes(sentinel), "no log line carries the input");
  } finally {
    Object.assign(console, originals);
  }
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
