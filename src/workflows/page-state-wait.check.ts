import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { FailureCodeError } from "../lib/automation/workflow-failures.ts";
import type { WorkflowInterventionPort } from "../lib/automation/workflow-executor.ts";
import { frameScope, FrameScopeTimeoutError, type FrameScope } from "./frame-scope.ts";
import { expectPageState } from "./page-state-wait.ts";

/** The wait reaches the page only through its probe, so the scope needs no browser. */
function scopeFor(signal: AbortSignal = new AbortController().signal): FrameScope {
  return frameScope({} as Page, signal);
}

/** A page whose expected state appears when `show()` is called. */
function pageState() {
  let shown = false;
  let probes = 0;
  return {
    probe: async () => {
      probes += 1;
      return shown ? "statement table" : null;
    },
    show: () => { shown = true; },
    probes: () => probes,
  };
}

type Answer = "none" | "handed-back";

/** An intervention port that records each consult and answers it with the given handlers. */
function interventionPort(answers: Readonly<{ safePoint?: () => Promise<Answer>; deadlineExpired?: () => Promise<Answer> }>) {
  const consults = { safePoint: 0, deadlineExpired: 0 };
  const port: WorkflowInterventionPort = {
    safePoint: async () => {
      consults.safePoint += 1;
      return await (answers.safePoint ?? (async () => "none" as const))();
    },
    deadlineExpired: async () => {
      consults.deadlineExpired += 1;
      return await (answers.deadlineExpired ?? (async () => "none" as const))();
    },
  };
  return { port, consults };
}

test("the wait returns the probe's value once the page reaches the expected state, without pausing", async () => {
  const page = pageState();
  const { port, consults } = interventionPort({});
  setTimeout(page.show, 300);
  const found = await expectPageState(scopeFor(), port, page.probe, "the statement table", { timeoutMs: 2_000 });
  assert.equal(found, "statement table");
  assert.equal(consults.deadlineExpired, 0);
  assert.ok(consults.safePoint > 0, "every wait is a Take over safe point");
});

test("in a manual run an expired wait requests a Run intervention, and after Hand back it re-checks the page", async () => {
  const page = pageState();
  const { port, consults } = interventionPort({
    deadlineExpired: async () => {
      // The person fixed the page while the run was paused, then handed it back.
      page.show();
      return "handed-back";
    },
  });
  const found = await expectPageState(scopeFor(), port, page.probe, "the statement table", { timeoutMs: 300 });
  assert.equal(found, "statement table");
  assert.equal(consults.deadlineExpired, 1);
});

test("a Hand back that leaves the page unchanged meets a fresh deadline, and a refused intervention fails with a step-wait timeout", async () => {
  const page = pageState();
  const expiredAt: number[] = [];
  const { port, consults } = interventionPort({
    deadlineExpired: async () => {
      expiredAt.push(Date.now());
      return expiredAt.length === 1 ? "handed-back" : "none";
    },
  });
  const error = await expectPageState(scopeFor(), port, page.probe, "the statement table", { timeoutMs: 300 })
    .then(() => assert.fail("the wait should time out"), (error: unknown) => error);
  assert.ok(error instanceof FrameScopeTimeoutError, "the run stop records a step-wait timeout");
  assert.equal((error as Error).message, "the statement table");
  assert.equal(consults.deadlineExpired, 2);
  assert.ok(expiredAt[1]! - expiredAt[0]! >= 280, "the deadline started again after Hand back");
});

test("a scheduled run, or a run with no person, fails the wait at its deadline with the same timeout", async () => {
  for (const port of [interventionPort({}).port, undefined]) {
    const page = pageState();
    const startedAt = Date.now();
    await assert.rejects(
      expectPageState(scopeFor(), port, page.probe, "the foreign statements page", { timeoutMs: 300 }),
      (error: unknown) => error instanceof FrameScopeTimeoutError && error.message === "the foreign statements page",
    );
    assert.ok(Date.now() - startedAt >= 280);
  }
});

test("a Take over handed back at the safe point re-checks the page with a fresh deadline", async () => {
  const page = pageState();
  let handedBackAt = 0;
  const startedAt = Date.now();
  const { port, consults } = interventionPort({
    safePoint: async () => {
      if (handedBackAt > 0 || Date.now() - startedAt < 200) return "none";
      // Paused for 400 ms, longer than the wait's own deadline.
      await new Promise((resolve) => setTimeout(resolve, 400));
      handedBackAt = Date.now();
      setTimeout(page.show, 150);
      return "handed-back";
    },
  });
  const found = await expectPageState(scopeFor(), port, page.probe, "the statement table", { timeoutMs: 300 });
  assert.equal(found, "statement table");
  assert.equal(consults.deadlineExpired, 0, "the pause did not count against the wait's deadline");
});

test("an intervention that ends the run ends the wait with its error, and a stop ends it with the run's reason", async () => {
  const timedOut = new FailureCodeError("run-intervention-timed-out");
  const { port } = interventionPort({ deadlineExpired: () => Promise.reject(timedOut) });
  await assert.rejects(
    expectPageState(scopeFor(), port, pageState().probe, "the statement table", { timeoutMs: 200 }),
    (error: unknown) => error === timedOut,
  );

  const run = new AbortController();
  const reason = new Error("run cancelled");
  const paused = interventionPort({ safePoint: () => new Promise(() => {}) });
  const waiting = expectPageState(scopeFor(run.signal), paused.port, pageState().probe, "the statement table", { timeoutMs: 5_000 });
  setTimeout(() => run.abort(reason), 100);
  await assert.rejects(waiting, (error: unknown) => error === reason);
});
