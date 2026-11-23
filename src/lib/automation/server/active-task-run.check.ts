import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { createDataVersionStore, type DataVersionStore } from "../../shared-shell/data-version.ts";
import type { CommitAttemptReport } from "../commit-attempt.ts";
import {
  activeRunPageLookup,
  finalizeOrphanedRuns,
  openActiveTaskRun,
  type TaskRunFailure,
  type TaskRunReport,
  type TaskRunStop,
} from "./active-task-run.ts";
import { hydrateAutomationRuntimeState } from "./runner.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import type { AutomationTaskStatus } from "./store.ts";
import type { WorkflowRunResult } from "../workflow-run-result.ts";
import { signalRunEvent, type WorkflowRunEvent } from "../run-event.ts";
import type { AutomationPersistencePort } from "./store.ts";
import { collectionNotification } from "./collection-summary.ts";
import { userActionForFailure } from "../workflow-failures.ts";
import { createTestPGlite } from"../../../ledger/pglite/baseline-test-template.ts";

const database = await createTestPGlite("operational");
const store = new PGliteStore(database);
after(() => database.close());
const provider = createPgliteOperationalProvider(store);
const persistence = provider.automation;

async function createRun(taskId = "exchange-rates", status: AutomationTaskStatus = "preparing", scheduledAtUtc?: string) {
  const kind = taskId.startsWith("sync-") || taskId === "exchange-rates" ? "sync" : "crawler";
  const { taskRunId } = await persistence.createTaskRun({
    taskId, kind, status, attempt: 1, maxAttempts: 1, startedAt: new Date().toISOString(),
    ...(scheduledAtUtc ? { scheduledAtUtc } : {}),
  });
  return taskRunId;
}

/** Timers that fire only when the check advances them, so a 5-minute wait takes no time. */
function fakeTimers() {
  let now = 0;
  const pending = new Set<{ at: number; callback: () => void }>();
  return {
    setTimeout(callback: () => void, ms: number) {
      const timer = { at: now + ms, callback };
      pending.add(timer);
      return timer;
    },
    clearTimeout(timer: unknown) {
      pending.delete(timer as { at: number; callback: () => void });
    },
    advance(ms: number) {
      now += ms;
      for (const timer of [...pending]) {
        if (timer.at > now) continue;
        pending.delete(timer);
        timer.callback();
      }
    },
    pending: () => pending.size,
  };
}

async function open(options: {
  taskId?: string;
  status?: AutomationTaskStatus;
  forceQuitAvailableAfterMs?: number;
  dataVersionStore?: DataVersionStore;
  scheduledAtUtc?: string;
  timers?: ReturnType<typeof fakeTimers>;
} = {}) {
  const taskRunId = await createRun(options.taskId, options.status, options.scheduledAtUtc);
  const runtime = createAutomationRuntimeState();
  const row = await persistence.taskRunById(taskRunId);
  const run = openActiveTaskRun({
    run: row!,
    persistence,
    runtime,
    dataVersionStore: options.dataVersionStore ?? createDataVersionStore(),
    ...(options.forceQuitAvailableAfterMs === undefined ? {} : { forceQuitAvailableAfterMs: options.forceQuitAvailableAfterMs }),
    ...(options.timers ? { interventionTimers: options.timers } : {}),
  });
  const published = () => runtime.snapshot().tasks.find((task) => task.runId === taskRunId);
  return { run, runtime, published, taskRunId };
}

const ok = (summary: WorkflowRunResult | null = null): TaskRunReport => ({ summary, failure: null });
const fail = (
  code: TaskRunFailure["code"],
  summary: WorkflowRunResult | null = null,
  proven = true,
): TaskRunReport => ({ summary, failure: { code, proven } });
const started = (attemptId: string): CommitAttemptReport =>
  ({ phase: "started", attemptId, product: "deposit", total: 1 });
const settled = (attemptId: string, outcome: "completed" | "failed" | "refused", committedCount = 0): CommitAttemptReport =>
  ({ phase: "settled", attemptId, outcome, committedCount });

const complete = { status: "completed", counts: {} } as const;
const partial = {
  status: "partial",
  counts: { committedCount: 1, itemCount: 1 },
  products: [{ typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 }],
} as const;
const incomplete: WorkflowRunResult = {
  status: "partial",
  counts: { committedCount: 1, itemCount: 1, excludedUnknownInstitutionCount: 1 },
  products: [{
    typeId: "settlement", status: "success", itemCount: 1, committedCount: 1,
    collection: { status: "incomplete", exclusionCounts: { excludedUnknownInstitutionCount: 1 } },
  }],
};

const refusedCard = { typeId: "credit_card", status: "failed", itemCount: 1, committedCount: 0, errorCode: "canonical-reset-required" } as const;
const resetRequiredPartial: WorkflowRunResult = {
  status: "partial",
  counts: { committedCount: 1, itemCount: 2 },
  products: [{ typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 }, refusedCard],
};
const resetRequiredOnly: WorkflowRunResult = { status: "failed", counts: { committedCount: 0, itemCount: 1 }, products: [refusedCard] };

type Scenario = Readonly<{
  name: string;
  attempts?: readonly CommitAttemptReport[];
  report: TaskRunReport;
  stops?: readonly TaskRunStop[];
  expected: Readonly<{ status: string; errorCode: string | null; forced?: boolean }>;
}>;

const scenarios: Scenario[] = [
  { name: "a success report without a summary", report: ok(), expected: { status: "completed", errorCode: null } },
  { name: "a successful typed summary", report: ok(complete), expected: { status: "completed", errorCode: null } },
  {
    name: "a typed failure overrides a completed summary",
    report: fail("source-integrity-failed", complete),
    expected: { status: "failed", errorCode: "source-integrity-failed" },
  },
  {
    name: "a failed summary without a code keeps its null code",
    report: ok({ status: "failed", counts: {} }),
    expected: { status: "failed", errorCode: null },
  },
  { name: "a partial summary without a fatal code", report: ok(partial), expected: { status: "partial", errorCode: null } },
  {
    name: "a non-TDCC partial summary cannot mask a typed fatal error",
    report: fail("source-unavailable", partial),
    expected: { status: "failed", errorCode: "source-unavailable" },
  },
  {
    name: "a TDCC incomplete collection with durable receipts keeps the interruption code",
    report: fail("source-unavailable", incomplete),
    expected: { status: "partial", errorCode: "source-unavailable" },
  },
  {
    name: "TDCC durable receipts keep partial even when the interrupted summary says failed",
    report: fail("source-unavailable", { ...incomplete, status: "failed" }),
    expected: { status: "partial", errorCode: "source-unavailable" },
  },
  {
    name: "a TDCC incomplete collection without receipts cannot override failure",
    report: fail("source-unavailable", {
      ...incomplete, status: "failed", counts: { committedCount: 0 },
      products: incomplete.products!.map((product) => ({ ...product, committedCount: 0 })),
    }),
    expected: { status: "failed", errorCode: "source-unavailable" },
  },
  {
    name: "inconsistent TDCC receipt counts cannot override failure",
    report: fail("source-unavailable", { ...incomplete, counts: { committedCount: 2 } }),
    expected: { status: "failed", errorCode: "source-unavailable" },
  },
  {
    name: "a workflow-reported cancellation overrides TDCC durable receipts",
    report: fail("cancelled", incomplete),
    expected: { status: "cancelled", errorCode: "cancelled" },
  },
  {
    name: "an unsettled attempt without a summary is commit outcome unknown",
    attempts: [started("a")],
    report: fail("workflow-failed", null, false),
    expected: { status: "failed", errorCode: "commit-outcome-unknown" },
  },
  {
    name: "an unsettled attempt outranks TDCC durable receipts",
    attempts: [started("a")],
    report: fail("source-unavailable", incomplete),
    expected: { status: "failed", errorCode: "commit-outcome-unknown" },
  },
  {
    name: "an unsettled attempt from an earlier round outranks a later successful round",
    attempts: [started("round-1"), started("round-2"), settled("round-2", "completed", 1)],
    report: ok(complete),
    expected: { status: "failed", errorCode: "commit-outcome-unknown" },
  },
  {
    name: "an unsettled attempt outranks a code the worker proved",
    attempts: [started("a")],
    report: fail("source-validation-failed"),
    expected: { status: "failed", errorCode: "commit-outcome-unknown" },
  },
  {
    name: "a refused attempt names the run even when the worker completed",
    attempts: [started("a"), settled("a", "refused")],
    report: ok(complete),
    expected: { status: "failed", errorCode: "collection-scope-changed" },
  },
  {
    name: "a refused attempt outranks a code the worker proved",
    attempts: [started("a"), settled("a", "completed", 1), started("b"), settled("b", "refused")],
    report: fail("workflow-failed"),
    expected: { status: "failed", errorCode: "collection-scope-changed" },
  },
  {
    name: "a refused attempt never hides an unsettled one",
    attempts: [started("a"), started("b"), settled("b", "refused")],
    report: fail("workflow-failed", null, false),
    expected: { status: "failed", errorCode: "commit-outcome-unknown" },
  },
  {
    name: "a failed attempt explains a failure classified from events",
    attempts: [started("a"), settled("a", "failed")],
    report: fail("authentication-failed", null, false),
    expected: { status: "failed", errorCode: "canonical-commit-failed" },
  },
  {
    name: "a code the worker proved outranks a failed attempt",
    attempts: [started("a"), settled("a", "failed")],
    report: fail("source-validation-failed"),
    expected: { status: "failed", errorCode: "source-validation-failed" },
  },
  {
    name: "a failed attempt does not fail a completed workflow",
    attempts: [started("a"), settled("a", "failed")],
    report: ok(complete),
    expected: { status: "completed", errorCode: null },
  },
  {
    name: "a product refused until a Canonical Reset names a run whose other products committed",
    attempts: [started("a"), settled("a", "completed", 1), started("b"), settled("b", "failed")],
    report: ok(resetRequiredPartial),
    expected: { status: "partial", errorCode: "canonical-reset-required" },
  },
  {
    name: "a run whose only product was refused until a Canonical Reset fails with that code",
    attempts: [started("a"), settled("a", "failed")],
    report: fail("canonical-reset-required", resetRequiredOnly),
    expected: { status: "failed", errorCode: "canonical-reset-required" },
  },
  {
    name: "a Canonical Reset requirement outranks a later product's failure",
    attempts: [started("a"), settled("a", "failed")],
    report: fail("source-unavailable", resetRequiredOnly),
    expected: { status: "failed", errorCode: "canonical-reset-required" },
  },
  {
    name: "a refused attempt outranks a Canonical Reset requirement",
    attempts: [started("a"), settled("a", "failed"), started("b"), settled("b", "refused")],
    report: ok(resetRequiredPartial),
    expected: { status: "failed", errorCode: "collection-scope-changed" },
  },
  {
    name: "a classified failure with no attempt keeps its code",
    report: fail("authentication-failed", null, false),
    expected: { status: "failed", errorCode: "authentication-failed" },
  },
];

const STOP_EXPECTATIONS: Readonly<Record<TaskRunStop, Scenario["expected"]>> = {
  forced: { status: "cancelled", errorCode: "cancelled", forced: true },
  cancelled: { status: "cancelled", errorCode: "cancelled" },
  shutdown: { status: "interrupted", errorCode: "cancelled" },
};

for (const stop of ["forced", "cancelled", "shutdown"] as const) {
  for (const report of [ok(complete), fail("source-unavailable", incomplete), fail("workflow-failed"), fail("cancelled")]) {
    scenarios.push({
      name: `a ${stop} stop outranks a ${report.failure?.code ?? "success"} report`,
      report,
      stops: [stop],
      expected: STOP_EXPECTATIONS[stop],
    });
  }
  scenarios.push({
    name: `a ${stop} stop outranks a refused attempt`,
    attempts: [started("a"), settled("a", "refused")],
    report: fail("workflow-failed"),
    stops: [stop],
    expected: STOP_EXPECTATIONS[stop],
  });
  for (const summary of [null, incomplete]) {
    scenarios.push({
      name: `an unsettled attempt outranks a ${stop} stop, ${summary ? "with" : "without"} earlier receipts`,
      attempts: [started("a")],
      report: fail("workflow-failed", summary, false),
      stops: [stop],
      expected: { status: "failed", errorCode: "commit-outcome-unknown" },
    });
  }
}

for (const scenario of scenarios) {
  test(`outcome: ${scenario.name}`, async () => {
    const { run, taskRunId } = await open();
    assert.equal(await run.transition("running"), true);
    for (const attempt of scenario.attempts ?? []) await run.recordCommitAttempt(attempt);
    for (const stop of scenario.stops ?? []) await run.requestStop(stop);
    const expected = { forced: false, ...scenario.expected };
    if (!scenario.stops?.length) {
      const assessed = run.assess(scenario.report);
      assert.deepEqual(
        { status: assessed.status, errorCode: assessed.errorCode, forced: assessed.forced },
        expected,
        "without a stop, assess answers what finish persists",
      );
    }
    const finished = await run.finish(scenario.report);
    assert.deepEqual(
      { status: finished.status, errorCode: finished.appWorkflowOutcome?.errorCode ?? null, forced: finished.terminationMode === "forced" },
      expected,
    );
    assert.equal((await persistence.taskRunById(taskRunId))?.status, expected.status);
  });
}

test("assess leaves the stop to the caller", async () => {
  const { run } = await open();
  await run.recordCommitAttempt(started("a"));
  await run.recordCommitAttempt(settled("a", "completed", 1));
  await run.requestStop("cancelled");
  assert.equal(run.assess(fail("captcha-provider-rejected")).errorCode, "captcha-provider-rejected");
  assert.equal(run.assess(ok(complete)).status, "completed");
  assert.equal((await run.finish(ok(complete))).status, "cancelled");
});

test("the outcome keeps the reported summary", async () => {
  const { run } = await open();
  await run.requestStop("cancelled");
  assert.deepEqual((await run.finish(ok(partial))).appWorkflowOutcome?.summary, partial);
});

test("cancellation state survives later progress writes in the published snapshot", async () => {
  const { run, published } = await open({ forceQuitAvailableAfterMs: 20 });
  assert.equal(await run.transition("running"), true);
  await run.requestStop("cancelled");
  const requestedAt = published()?.cancellationRequestedAt;
  assert.ok(requestedAt);
  assert.equal(published()?.forceTerminateAvailable, false);

  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(published()?.forceTerminateAvailable, true, "force-quit is offered once cleanup had its time");
  await run.update({ progress: { phaseCode: "sync", completed: 1, total: 3, percent: 33, attempt: 1 } });
  assert.equal(published()?.status, "cancelling");
  assert.equal(published()?.cancellationRequestedAt, requestedAt);
  assert.equal(published()?.forceTerminateAvailable, true, "a progress write keeps the force-quit control");
  assert.equal(published()?.progress.percent, 33);
  await run.finish(ok());
});

test("a cancelling run refuses every move except its end", async () => {
  const { run, taskRunId } = await open();
  assert.equal(await run.transition("running"), true);
  await run.requestStop("cancelled");
  for (const status of ["running", "waiting_for_human", "queued", "preparing"] as const) {
    assert.equal(await run.transition(status), false, `cancelling moved to ${status}`);
  }
  assert.equal((await persistence.taskRunById(taskRunId))?.status, "cancelling");
  assert.equal((await run.finish(ok())).status, "cancelled");
});

test("finish persists once and ignores later writes", async () => {
  const { run, published, taskRunId } = await open();
  assert.equal(await run.transition("running"), true);
  const [first, second] = await Promise.all([run.finish(ok()), run.finish(fail("workflow-failed"))]);
  assert.equal(first.status, "completed");
  assert.equal(second, first);
  assert.equal(await run.transition("running"), false);
  await run.update({ attempt: 2 });
  await run.requestStop("cancelled");
  const saved = await persistence.taskRunById(taskRunId);
  assert.equal(saved?.status, "completed");
  assert.equal(saved?.attempt, 1);
  assert.equal(published()?.status, "completed");
  assert.equal(run.signal.aborted, false);
});

for (const { stops, status, forced } of [
  { stops: ["cancelled", "shutdown"], status: "cancelled", forced: false },
  { stops: ["shutdown", "cancelled"], status: "cancelled", forced: false },
  { stops: ["cancelled", "forced"], status: "cancelled", forced: true },
  { stops: ["shutdown"], status: "interrupted", forced: false },
] satisfies Array<{ stops: TaskRunStop[]; status: string; forced: boolean }>) {
  test(`stops ${stops.join(" then ")} end the run ${forced ? "force-quit" : status}`, async () => {
    const { run } = await open();
    assert.equal(await run.transition("running"), true);
    for (const stop of stops) await run.requestStop(stop);
    assert.equal(run.signal.aborted, true);
    assert.equal(run.forceSignal.aborted, forced);
    const finished = await run.finish(ok());
    assert.equal(finished.status, status);
    assert.equal(finished.terminationMode === "forced", forced);
  });
}

test("finish waits for a Commit attempt that is still being recorded", async () => {
  const { run } = await open();
  const recording = run.recordCommitAttempt(started("in-flight"));
  const finished = run.finish(ok(complete));
  await recording;
  assert.equal((await finished).appWorkflowOutcome?.errorCode, "commit-outcome-unknown");
});

test("a settlement the store failed to record still counts and marks data stale", async () => {
  const invalidations = createDataVersionStore();
  const { run, taskRunId } = await open({ taskId: "post-statements", dataVersionStore: invalidations });
  await run.recordCommitAttempt(started("a"));
  const record = persistence.recordCommitAttempt.bind(persistence);
  persistence.recordCommitAttempt = async () => { throw new Error("operational RPC unavailable"); };
  try {
    await assert.rejects(run.recordCommitAttempt(settled("a", "completed", 1)));
  } finally {
    persistence.recordCommitAttempt = record;
  }
  const saved = await run.finish(fail("workflow-failed", null, false));
  assert.equal(saved.appWorkflowOutcome?.errorCode, "workflow-failed", "the settlement was known to the owner");
  assert.equal(invalidations.snapshot().version, 1, "the settled commit may have changed data");
  assert.deepEqual((await persistence.commitAttempts(taskRunId)).map((attempt) => attempt.outcome), [null]);
});

test("a start the store failed to record is not an attempt, so nothing was committed", async () => {
  const invalidations = createDataVersionStore();
  const { run } = await open({ taskId: "post-statements", dataVersionStore: invalidations });
  const record = persistence.recordCommitAttempt.bind(persistence);
  persistence.recordCommitAttempt = async () => { throw new Error("operational RPC unavailable"); };
  try {
    await assert.rejects(run.recordCommitAttempt(started("a")));
  } finally {
    persistence.recordCommitAttempt = record;
  }
  const saved = await run.finish(fail("workflow-failed", null, false));
  assert.equal(saved.appWorkflowOutcome?.errorCode, "workflow-failed");
  assert.equal(invalidations.snapshot().version, 0);
});

test("a partial outcome invalidates data once without retaining log output", async () => {
  const invalidations = createDataVersionStore();
  const { run } = await open({ taskId: "fubon-all-statements", status: "running", dataVersionStore: invalidations });
  const summary = {
    status: "partial" as const,
    counts: { itemCount: 1, committedCount: 1 },
    products: [
      { typeId: "deposit" as const, status: "success" as const, itemCount: 1, committedCount: 1 },
      { typeId: "loan" as const, status: "failed" as const, itemCount: 0, committedCount: 0, errorCode: "source-collection-failed" as const },
    ],
  };
  const saved = await run.finish(ok(summary));
  assert.equal(saved.status, "partial");
  assert.deepEqual(saved.appWorkflowOutcome, { errorCode: null, summary });
  assert.equal(invalidations.snapshot().version, 1);
});

test("a forced cancellation retains product receipts, records force and invalidates data", async () => {
  const invalidations = createDataVersionStore();
  const { run } = await open({ taskId: "fubon-all-statements", status: "running", dataVersionStore: invalidations });
  const summary = {
    status: "completed" as const,
    counts: { itemCount: 1, committedCount: 1 },
    products: [{ typeId: "deposit" as const, status: "success" as const, itemCount: 1, committedCount: 1 }],
  } as const;
  await run.requestStop("forced");
  const saved = await run.finish(fail("cancelled", summary));
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.terminationMode, "forced");
  assert.deepEqual(saved.appWorkflowOutcome, { errorCode: "cancelled", summary });
  assert.equal(invalidations.snapshot().version, 1, "a verified earlier product commit makes data stale after forced stop");
});

test("a settled Commit attempt invalidates data when a later worker crash has no summary", async () => {
  const invalidations = createDataVersionStore();
  const { run } = await open({ taskId: "yuanta-all-statements", status: "running", dataVersionStore: invalidations });
  await run.recordCommitAttempt(started("deposit-attempt"));
  await run.recordCommitAttempt(settled("deposit-attempt", "completed", 1));
  const saved = await run.finish(fail("workflow-failed", null, false));
  assert.equal(saved.status, "failed");
  assert.equal(invalidations.snapshot().version, 1, "only a durable Commit attempt proves earlier progress");
});

test("an unsettled Commit attempt invalidates data because the write may have landed", async () => {
  const invalidations = createDataVersionStore();
  const { run } = await open({ taskId: "yuanta-all-statements", status: "running", dataVersionStore: invalidations });
  await run.recordCommitAttempt(started("deposit-attempt"));
  await run.finish(fail("workflow-failed", null, false));
  assert.equal(invalidations.snapshot().version, 1);
});

test("a failure without receipts leaves fresh data alone", async () => {
  const invalidations = createDataVersionStore();
  const { run } = await open({ taskId: "yuanta-all-statements", status: "running", dataVersionStore: invalidations });
  await run.finish(fail("workflow-failed"));
  assert.equal(invalidations.snapshot().version, 0);
});

test("a typed App outcome is retained in run metadata", async () => {
  const { run } = await open({ taskId: "ctbc-statements", status: "running" });
  const summary = { status: "financial-admitted" as const, counts: { accountCount: 2, rowCount: 18, itemCount: 12 } };
  const saved = await run.finish(ok(summary));
  assert.equal(saved.status, "completed");
  assert.deepEqual(saved.appWorkflowOutcome, { errorCode: null, summary });
  assert.ok(saved.recordJson.includes('"appWorkflowOutcome"'));
});

test("a typed cancellation code ends the run cancelled without force", async () => {
  const { run } = await open({ taskId: "ctbc-statements", status: "running" });
  const saved = await run.finish(fail("cancelled"));
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.appWorkflowOutcome?.errorCode, "cancelled");
  assert.equal(saved.terminationMode, undefined);
});

const stoppedAt = { step: "login-submitted", page: { kind: "step-wait-timeout", host: "bank.example", path: "/login" } } as const;

test("a failed run's outcome keeps where it stopped, and a cancelled run's does not", async () => {
  const { run, taskRunId } = await open({ taskId: "ctbc-statements", status: "running" });
  const saved = await run.finish({ summary: null, failure: { code: "authentication-timeout", proven: false, stoppedAt } });
  assert.equal(saved.status, "failed");
  assert.deepEqual(saved.appWorkflowOutcome, { errorCode: "authentication-timeout", summary: null, stoppedAt });
  assert.deepEqual((await persistence.taskRunById(taskRunId))?.appWorkflowOutcome?.stoppedAt, stoppedAt);
  const history = await persistence.recentTaskRuns(500);
  assert.deepEqual(history.find((row) => row.taskRunId === taskRunId)?.appWorkflowOutcome?.stoppedAt, stoppedAt, "run history shows it");

  const cancelled = await open({ taskId: "ctbc-statements", status: "running" });
  await cancelled.run.requestStop("cancelled");
  const ended = await cancelled.run.finish({ summary: null, failure: { code: "authentication-timeout", proven: false, stoppedAt } });
  assert.equal(ended.status, "cancelled");
  assert.equal(ended.appWorkflowOutcome?.stoppedAt, undefined);
});

test("a scheduled run's User-action Failure carries the step and page kind it stopped on", async () => {
  // A run is finished the same way whatever started it; only the summary reads the trigger.
  const { run } = await open({ taskId: "ctbc-statements", status: "running" });
  const urlStop = { step: "login-submitted", page: { kind: "url", host: "bank.example", path: "/locked" } } as const;
  const saved = await run.finish({ summary: null, failure: { code: "authentication-failed", proven: true, stoppedAt: urlStop } });
  assert.equal(userActionForFailure(saved.appWorkflowOutcome?.errorCode), "check-sign-in-details");
  assert.deepEqual(saved.appWorkflowOutcome?.stoppedAt, urlStop);
  const notice = collectionNotification([{ taskId: "ctbc-statements", run: saved }], "scheduled", "en");
  assert.equal(notice?.title, "Automatic sync needs you");
});

test("no persisted record of a failed run holds page text, a picture, or the URL query", async () => {
  const { run } = await open({ taskId: "ctbc-statements", status: "running" });
  const execution = run.beginExecution("execution-privacy");
  await execution.appendEvent({
    runId: run.taskRunId, stage: "finalization", outcome: "failed", code: "run-failed",
    occurredAt: "2026-11-22T00:00:00.000Z", stoppedAt,
  });
  execution.end();
  const leaking = {
    step: "login-submitted",
    page: { kind: "url", host: "bank.example", path: "/login?token=SECRET", text: "BALANCE 12,345", screenshot: "iVBORw0KGgo=" },
  } as unknown as typeof stoppedAt;
  const saved = await run.finish({ summary: null, failure: { code: "authentication-failed", proven: false, stoppedAt: leaking } });
  assert.equal(saved.appWorkflowOutcome?.stoppedAt, undefined);
  assert.deepEqual(saved.events.at(-1)?.stoppedAt, stoppedAt);
  for (const secret of ["SECRET", "token", "BALANCE", "12,345", "iVBORw0KGgo"]) {
    assert.equal(saved.recordJson.includes(secret), false, secret);
  }
});

test("a completed run can leave the human-assistance waiting state", async () => {
  const { run } = await open({ taskId: "ctbc-statements", status: "waiting_for_human" });
  const saved = await run.finish(ok({ status: "financial-admitted", counts: { itemCount: 2 } }));
  assert.equal(saved.status, "completed");
});

test("two owners of one row persist one outcome and apply freshness and notices once", async () => {
  const resolveNotices = persistence.resolveTaskPrerequisiteNotices.bind(persistence);
  let noticesResolved = 0;
  persistence.resolveTaskPrerequisiteNotices = async (...args) => {
    noticesResolved += 1;
    return resolveNotices(...args);
  };
  try {
    const summary = { status: "completed", counts: { committedCount: 1, itemCount: 1 } } as const;
    const taskRunId = await createRun("yuanta-trade-statements", "running");
    const invalidations = createDataVersionStore();
    const row = await persistence.taskRunById(taskRunId);
    const owners = [0, 1].map(() => openActiveTaskRun({
      run: row!, persistence, runtime: createAutomationRuntimeState(), dataVersionStore: invalidations,
    }));
    const winners = await Promise.all(owners.map((owner) => owner.finish(ok(summary))));
    assert.deepEqual(winners.map((run) => run.status), ["completed", "completed"]);
    const late = openActiveTaskRun({
      run: row!, persistence, runtime: createAutomationRuntimeState(), dataVersionStore: invalidations,
    });
    assert.equal((await late.finish(fail("source-unavailable"))).status, "completed", "a later owner keeps the first outcome");
    assert.equal(invalidations.snapshot().version, 1);
    assert.equal(noticesResolved, 1);
  } finally {
    persistence.resolveTaskPrerequisiteNotices = resolveNotices;
  }
});

test("orphaned runs are interrupted before the runtime hydrates", async () => {
  const taskRunId = await createRun("exchange-rates", "queued");
  await finalizeOrphanedRuns(provider);
  const saved = await persistence.taskRunById(taskRunId);
  assert.equal(saved?.status, "interrupted");
  assert.ok(saved?.finishedAt);
  assert.deepEqual(await persistence.activeTaskRuns(), []);
  const runtime = await hydrateAutomationRuntimeState(provider, createAutomationRuntimeState());
  assert.equal(runtime.tasks.find((task) => task.taskId === "exchange-rates")?.status, "interrupted");
});

test("an orphaned run with an unsettled Commit attempt is commit outcome unknown", async () => {
  const taskRunId = await createRun("post-statements", "running");
  await persistence.recordCommitAttempt(taskRunId, started("post-attempt"));
  await finalizeOrphanedRuns(provider);
  const saved = await persistence.taskRunById(taskRunId);
  assert.equal(saved?.status, "failed", "an uncertain financial write outranks the interruption");
  assert.deepEqual(saved?.appWorkflowOutcome, { errorCode: "commit-outcome-unknown", summary: null });
});

test("an orphaned run whose attempts all settled is interrupted and still marks data stale", async () => {
  const taskRunId = await createRun("post-statements", "running");
  await persistence.recordCommitAttempt(taskRunId, started("post-attempt"));
  await persistence.recordCommitAttempt(taskRunId, settled("post-attempt", "completed", 1));
  const invalidations = createDataVersionStore();
  await finalizeOrphanedRuns(provider, { dataVersionStore: invalidations });
  const saved = await persistence.taskRunById(taskRunId);
  assert.equal(saved?.status, "interrupted");
  assert.deepEqual(saved?.appWorkflowOutcome, { errorCode: "cancelled", summary: null });
  assert.equal(invalidations.snapshot().version, 1);
});

test("an orphaned run with no Commit attempt is interrupted and leaves data fresh", async () => {
  const taskRunId = await createRun("post-statements", "running");
  const invalidations = createDataVersionStore();
  await finalizeOrphanedRuns(provider, { dataVersionStore: invalidations });
  const saved = await persistence.taskRunById(taskRunId);
  assert.equal(saved?.status, "interrupted");
  assert.equal(saved?.appWorkflowOutcome?.errorCode, "cancelled");
  assert.equal(invalidations.snapshot().version, 0);
});

test("an orphaned run keeps its typed summary under the quit's error code", async () => {
  const taskRunId = await createRun("exchange-rates", "running");
  await persistence.updateTaskRun(taskRunId, {
    appWorkflowOutcome: { errorCode: null, summary: { status: "completed", counts: { itemCount: 4 } } },
  });
  await finalizeOrphanedRuns(provider);
  const saved = await persistence.taskRunById(taskRunId);
  assert.equal(saved?.status, "interrupted");
  assert.deepEqual(saved?.appWorkflowOutcome, {
    errorCode: "cancelled",
    summary: { status: "completed", counts: { itemCount: 4 } },
  });
});

const workerEvent = (runId: string, code: string, retrying?: true): WorkflowRunEvent => ({
  runId, occurredAt: new Date().toISOString(), stage: "collection", outcome: "advanced", code,
  ...(retrying ? { retrying } : {}),
});
const storedCodes = async (taskRunId: string) =>
  (await persistence.taskRunById(taskRunId))?.events.map((event) => event.code) ?? [];

test("a Workflow execution logs each event once, host signals included, past the store's event cap", async () => {
  const { run, taskRunId } = await open();
  // An earlier execution left the store one short of its 200-event cap, so the
  // next appends shift which stored events survive.
  for (let index = 0; index < 199; index += 1) {
    await persistence.appendRunEvent(workerEvent(taskRunId, `earlier-${index}`));
  }
  const execution = run.beginExecution("round-1");
  assert.equal(run.currentExecution(), execution);
  await execution.appendEvent(workerEvent(taskRunId, "collection-advanced", true));
  await execution.appendEvent(signalRunEvent("solver-route-unavailable", { runId: taskRunId, occurredAt: new Date().toISOString() }));
  await execution.appendEvent(workerEvent(taskRunId, "collection-completed"));
  assert.deepEqual(
    execution.events().map((event) => event.code),
    ["collection-advanced", "solver-route-unavailable", "collection-completed"],
  );
  assert.equal(execution.events()[0]?.retrying, true, "the log holds the same copy the store does");
  const stored = (await persistence.taskRunById(taskRunId))!.events;
  assert.equal(stored.length, 200);
  assert.deepEqual(stored.slice(-3).map((event) => event.code), ["collection-advanced", "solver-route-unavailable", "collection-completed"]);
  assert.equal(stored.at(-3)?.retrying, true);
  execution.end();
  assert.equal(run.currentExecution(), null);
  await run.finish(ok());
});

test("one execution is current at a time, each sees only its own events, and an ended one records nothing", async () => {
  const { run, taskRunId } = await open();
  const first = run.beginExecution("round-1");
  assert.throws(() => run.beginExecution("round-2"), /round-1 .* still current/u);
  await first.appendEvent(workerEvent(taskRunId, "first-only"));
  first.end();
  first.end();
  const second = run.beginExecution("round-2");
  await second.appendEvent(workerEvent(taskRunId, "second-only"));
  assert.deepEqual(first.events().map((event) => event.code), ["first-only"]);
  assert.deepEqual(second.events().map((event) => event.code), ["second-only"]);
  await assert.rejects(first.appendEvent(workerEvent(taskRunId, "late")), /round-1 has ended/u);
  assert.deepEqual(first.events().map((event) => event.code), ["first-only"]);
  assert.deepEqual(await storedCodes(taskRunId), ["first-only", "second-only"]);
  second.end();
  await run.finish(ok());
});

test("execution events persist behind the run's earlier writes and ahead of its later ones", async () => {
  const taskRunId = await createRun();
  const calls: string[] = [];
  const recording = new Proxy(persistence, {
    get(target, property: keyof AutomationPersistencePort) {
      const member = target[property];
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        calls.push(property);
        return (member as (...input: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const run = openActiveTaskRun({
    run: (await persistence.taskRunById(taskRunId))!,
    persistence: recording,
    runtime: createAutomationRuntimeState(),
    dataVersionStore: createDataVersionStore(),
  });
  const execution = run.beginExecution("round-1");
  const update = run.update({ attempt: 1 });
  const appended = execution.appendEvent(workerEvent(taskRunId, "ordered"));
  const transition = run.transition("running");
  await Promise.all([update, appended, transition]);
  assert.deepEqual(calls, ["updateTaskRun", "appendRunEvent", "transitionTaskRunToActive"]);
  execution.end();
  await run.finish(ok());
});

test("an event accepted before finish is stored before the terminal write; later appends are not", async () => {
  const { run, taskRunId } = await open();
  const execution = run.beginExecution("round-1");
  const accepted = execution.appendEvent(workerEvent(taskRunId, "before-finish"));
  const finished = run.finish(ok());
  await Promise.all([accepted, finished]);
  assert.deepEqual(await storedCodes(taskRunId), ["before-finish"]);
  assert.equal((await persistence.taskRunById(taskRunId))?.status, "completed");

  await execution.appendEvent(workerEvent(taskRunId, "after-finish"));
  assert.deepEqual(execution.events().map((event) => event.code), ["before-finish", "after-finish"], "the log stays complete");
  await run.appendEvent(signalRunEvent("verification-solver-exhausted", { runId: taskRunId, occurredAt: new Date().toISOString() }));
  assert.deepEqual(await storedCodes(taskRunId), ["before-finish"], "a finished run persists no more events");
  execution.end();
  assert.throws(() => run.beginExecution("round-2"), /has finished/u);
});

test("an event the run records between executions joins no execution's log", async () => {
  const { run, taskRunId } = await open();
  const first = run.beginExecution("round-1");
  first.end();
  await run.appendEvent(signalRunEvent("verification-solver-exhausted", { runId: taskRunId, occurredAt: new Date().toISOString() }));
  const second = run.beginExecution("round-2");
  assert.deepEqual(first.events(), []);
  assert.deepEqual(second.events(), []);
  assert.deepEqual(await storedCodes(taskRunId), ["verification-solver-exhausted"]);
  second.end();
  await run.finish(ok());
});

test("the App page lookup reaches the page the current execution hosts, and nothing after it ends", async () => {
  const { run, taskRunId } = await open({ taskId: "sinopac-statements" });
  const other = await open({ taskId: "sinopac-statements" });
  const runs = new Map([[taskRunId, run], [other.taskRunId, other.run]]);
  const pageForRun = activeRunPageLookup((id) => runs.get(id) ?? null);
  const page = { name: "first" } as never;

  const first = run.beginExecution("round-1");
  assert.equal(pageForRun(taskRunId), null, "no page before the host opens one");
  const release = first.hostPage({ page });
  assert.throws(() => first.hostPage({ page }), /already hosts a browser page/u);
  assert.equal(pageForRun(taskRunId), page);
  assert.equal(first.page(), page);
  assert.equal(pageForRun(other.taskRunId), null, "another run never sees this page");
  assert.equal(pageForRun("unknown-run"), null);
  release();
  assert.equal(pageForRun(taskRunId), null, "closing the page releases it");
  assert.equal(first.page(), null);

  first.hostPage({ page });
  first.end();
  assert.equal(pageForRun(taskRunId), null, "ending the execution releases its page");
  assert.equal(first.page(), null);
  assert.throws(() => first.hostPage({ page }), /round-1 has ended/u);

  const second = run.beginExecution("round-2");
  assert.equal(pageForRun(taskRunId), null, "a later execution starts without the earlier page");
  const secondPage = { name: "second" } as never;
  const releaseSecond = second.hostPage({ page: secondPage });
  release();
  assert.equal(pageForRun(taskRunId), secondPage, "an earlier release leaves a later page alone");
  releaseSecond();
  second.end();
  await run.finish(ok());
  runs.delete(taskRunId);
  assert.equal(pageForRun(taskRunId), null, "a finished run is no longer active");
  await other.run.finish(ok());
});

test("the published snapshot says whether a person or the schedule started the run", async () => {
  const manual = await open({ taskId: "sinopac-statements" });
  const scheduled = await open({ taskId: "sinopac-statements", scheduledAtUtc: "2026-11-22T01:00:00.000Z" });
  assert.equal(manual.run.trigger, "manual");
  assert.equal(scheduled.run.trigger, "scheduled");
  assert.equal(manual.published()?.trigger, "manual");
  assert.equal(scheduled.published()?.trigger, "scheduled");
  await manual.run.transition("running");
  assert.equal(manual.published()?.trigger, "manual", "later writes keep the trigger");
  await manual.run.finish(ok());
  await scheduled.run.finish(ok());
  assert.equal(manual.published()?.trigger, "manual", "the finished snapshot keeps it too");
});

test("a run records when the person watched it as metadata only, and its end closes an open view", async () => {
  const { run, taskRunId } = await open({ taskId: "sinopac-statements" });
  await run.transition("running");
  await run.recordIntervention("view-opened");
  await run.recordIntervention("view-closed");
  await run.recordIntervention("view-opened");
  const stored = await persistence.taskRunById(taskRunId);
  assert.deepEqual(stored?.interventionLog?.map((entry) => entry.action), ["view-opened", "view-closed", "view-opened"]);
  for (const entry of stored?.interventionLog ?? []) {
    assert.deepEqual(Object.keys(entry).sort(), ["action", "at"], "an entry holds an action and its time, nothing else");
    assert.equal(new Date(entry.at).toISOString(), entry.at);
  }
  assert.deepEqual(stored?.events, [], "watching is not a workflow event, so no stage track or failure stage moves");

  await run.finish(ok());
  const finished = await persistence.taskRunById(taskRunId);
  assert.deepEqual(finished?.interventionLog?.map((entry) => entry.action), ["view-opened", "view-closed", "view-opened", "view-closed"]);
  await run.recordIntervention("view-opened");
  assert.equal((await persistence.taskRunById(taskRunId))?.interventionLog?.length, 4, "a finished run records nothing more");
});

test("the store keeps only known intervention actions with their times", async () => {
  const taskRunId = await createRun("sinopac-statements", "running");
  await persistence.updateTaskRun(taskRunId, {
    interventionLog: [
      { action: "view-opened", at: "2026-11-22T01:00:00.000Z" },
      { action: "view-opened", at: "2026-11-22T01:00:01.000Z", frame: "data:image/jpeg;base64,SECRET" },
      { action: "typed", at: "2026-11-22T01:00:02.000Z" },
      { action: "view-closed", at: "not a time" },
    ] as never,
  });
  const stored = await persistence.taskRunById(taskRunId);
  assert.deepEqual(stored?.interventionLog, [
    { action: "view-opened", at: "2026-11-22T01:00:00.000Z" },
    { action: "view-opened", at: "2026-11-22T01:00:01.000Z" },
  ]);
  assert.doesNotMatch(stored!.recordJson, /SECRET|typed/u);
});

// Run intervention (ADR 0147). A fake workflow execution consults the run at
// its safe points the way the intervention host call does; the page is a token.
const interventionActions = async (taskRunId: string) =>
  (await persistence.taskRunById(taskRunId))?.interventionLog?.map((entry) => entry.action) ?? [];
const storedSignals = async (taskRunId: string) =>
  (await persistence.taskRunById(taskRunId))?.events.map((event) => event.signal ?? event.code) ?? [];

async function runningManual(timers = fakeTimers()) {
  const opened = await open({ taskId: "sinopac-statements", timers });
  await opened.run.transition("running");
  const execution = opened.run.beginExecution("round-1");
  execution.hostPage({ page: { name: "page" } as never });
  return { ...opened, execution, timers };
}

/** Settles to the value, or "unsettled" when it has not settled once pending work has run. */
async function settledOrNot<T>(promise: Promise<T>): Promise<T | "unsettled"> {
  return await Promise.race([promise, new Promise<"unsettled">((resolve) => setImmediate(() => resolve("unsettled")))]);
}

test("Take over pauses a manual run only at its next safe point, and Hand back resumes it", async () => {
  const { run, taskRunId, execution, published } = await runningManual();
  const signal = new AbortController().signal;
  assert.equal(await run.interventionSafePoint(signal), null, "a safe point with no request does not pause");
  assert.equal(run.intervention(), null);

  assert.deepEqual(await run.requestTakeOver(), { ok: true });
  assert.equal(run.intervention(), "requested", "the request waits for a safe point");
  assert.equal(published()?.intervention, "requested");
  assert.deepEqual(await run.requestTakeOver(), { ok: false, refused: "pending" });

  const paused = run.interventionSafePoint(signal);
  assert.equal(await settledOrNot(paused), "unsettled", "the workflow waits at the safe point");
  assert.equal(run.intervention(), "paused");
  assert.equal(published()?.intervention, "paused");
  assert.equal(run.current().status, "running", "a paused run keeps its browser and stays active");

  assert.equal(await run.handBack(), true);
  assert.equal(await paused, "handed-back");
  assert.equal(run.intervention(), null);
  assert.equal(published()?.intervention, undefined);
  assert.equal(await run.handBack(), false, "nothing is paused any more");
  assert.equal(await run.interventionSafePoint(signal), null, "the next safe point runs on");

  assert.deepEqual(await interventionActions(taskRunId), ["take-over", "paused", "handed-back"]);
  assert.deepEqual(await storedSignals(taskRunId), [
    "run-intervention-requested", "run-intervention-paused", "run-intervention-handed-back",
  ]);
  assert.deepEqual(execution.events(), [], "intervention signals join no execution's log, so no classification reads them");
  execution.end();
  await run.finish(ok());
  assert.equal((await persistence.taskRunById(taskRunId))?.status, "completed");
});

test("Give up ends a paused run as a cancel", async () => {
  const { run, taskRunId, execution, timers } = await runningManual();
  await run.requestTakeOver();
  const paused = run.interventionSafePoint(run.signal);
  await settledOrNot(paused);
  assert.equal(await run.giveUp(), true);
  // The stop abandons the workflow's wait, as the host call's stop rule does.
  assert.equal(await paused, "given-up");
  assert.equal(run.stopReason(), "cancelled");
  assert.equal(run.signal.aborted, true);
  assert.equal(run.intervention(), null);
  assert.equal(timers.pending(), 0, "the 5 minutes stop with the pause");
  execution.end();
  await run.finish(fail("cancelled"));
  const finished = await persistence.taskRunById(taskRunId);
  assert.equal(finished?.status, "cancelled");
  assert.deepEqual(finished?.interventionLog?.map((entry) => entry.action), ["take-over", "paused", "given-up"]);
  assert.equal(await run.giveUp(), false);
});

test("five minutes paused without the person ends the run with a User-action Failure and releases the page", async () => {
  const { run, taskRunId, execution, timers, published } = await runningManual();
  const pageForRun = activeRunPageLookup((id) => (id === taskRunId ? run : null));
  await run.requestTakeOver();
  const paused = run.interventionSafePoint(run.signal);
  await settledOrNot(paused);
  timers.advance(5 * 60_000 - 1);
  assert.equal(await settledOrNot(paused), "unsettled", "the person still has a moment");
  assert.equal(run.intervention(), "paused");
  timers.advance(1);
  assert.equal(await paused, "timed-out");
  assert.equal(run.intervention(), null);
  assert.equal(published()?.intervention, undefined);
  assert.equal(await run.handBack(), false, "a late Hand back finds nothing paused");

  // The workflow hears timed-out and ends, which closes the page it hosted;
  // whatever code it reports, the run failed because no one came.
  execution.end();
  assert.equal(pageForRun(taskRunId), null, "the source's browser page is released");
  await run.finish(fail("workflow-failed", null, false));
  const finished = await persistence.taskRunById(taskRunId);
  assert.equal(finished?.status, "failed");
  assert.equal(finished?.appWorkflowOutcome?.errorCode, "run-intervention-timed-out");
  assert.equal(userActionForFailure(finished?.appWorkflowOutcome?.errorCode), "attend-paused-run");
  assert.deepEqual(finished?.interventionLog?.map((entry) => entry.action), ["take-over", "paused", "timed-out"]);
  assert.deepEqual(await storedSignals(taskRunId), [
    "run-intervention-requested", "run-intervention-paused", "run-intervention-timed-out",
  ]);
});

test("a stop while paused ends the pause and the workflow's wait", async () => {
  const { run, execution, timers } = await runningManual();
  await run.requestTakeOver();
  const paused = run.interventionSafePoint(run.signal);
  await settledOrNot(paused);
  await run.requestStop("cancelled");
  await assert.rejects(paused);
  assert.equal(run.intervention(), null);
  assert.equal(timers.pending(), 0);
  assert.deepEqual(await run.requestTakeOver(), { ok: false, refused: "not-running" });
  execution.end();
  await run.finish(fail("cancelled"));
});

test("a pause ends with the execution that holds it, so a later timer cannot turn another failure into a timeout", async () => {
  const { run, taskRunId, execution, timers } = await runningManual();
  await run.requestTakeOver();
  const paused = run.interventionSafePoint(run.signal);
  await settledOrNot(paused);
  // The workflow stopped waiting (say a dialog failed the sign-in) and its worker ended.
  execution.end();
  await assert.rejects(paused, /has ended/u);
  assert.equal(run.intervention(), null);
  assert.equal(timers.pending(), 0, "the 5 minutes stop with the pause");
  timers.advance(10 * 60_000);
  await run.finish(fail("authentication-dialog-interrupted"));
  const finished = await persistence.taskRunById(taskRunId);
  assert.equal(finished?.appWorkflowOutcome?.errorCode, "authentication-dialog-interrupted");
  assert.deepEqual(finished?.interventionLog?.map((entry) => entry.action), ["take-over", "paused"]);
});

test("Take over is refused for a scheduled run, during a Verification Stage, and when the run is not running", async () => {
  const scheduled = await open({ taskId: "sinopac-statements", scheduledAtUtc: "2026-11-22T01:00:00.000Z" });
  await scheduled.run.transition("running");
  assert.deepEqual(await scheduled.run.requestTakeOver(), { ok: false, refused: "not-manual" });
  assert.equal(await scheduled.run.interventionSafePoint(scheduled.run.signal), null);
  await scheduled.run.finish(ok());
  assert.deepEqual(await interventionActions(scheduled.taskRunId), [], "a refusal records nothing");

  const preparing = await open({ taskId: "sinopac-statements" });
  assert.deepEqual(await preparing.run.requestTakeOver(), { ok: false, refused: "not-running" });

  const { run, taskRunId, execution } = await runningManual();
  await run.transition("waiting_for_human");
  assert.deepEqual(await run.requestTakeOver(), { ok: false, refused: "verifying" });
  await run.transition("running");
  assert.deepEqual(await run.requestTakeOver(), { ok: true });
  // The request stands, but a safe point inside a Verification Stage never pauses it.
  await run.transition("waiting_for_human");
  assert.equal(await run.interventionSafePoint(run.signal), null);
  assert.equal(run.intervention(), "requested");
  await run.transition("running");
  execution.end();
  await run.finish(ok());
  assert.equal(run.intervention(), null, "finishing withdraws a request still waiting");
  assert.deepEqual(await run.requestTakeOver(), { ok: false, refused: "not-running" });
  assert.deepEqual(await interventionActions(taskRunId), ["take-over"]);
  await preparing.run.finish(ok());
});

test("a run pauses once and then at most three more times", async () => {
  const { run, execution } = await runningManual();
  for (let pause = 0; pause < 4; pause += 1) {
    assert.deepEqual(await run.requestTakeOver(), { ok: true });
    const paused = run.interventionSafePoint(run.signal);
    await settledOrNot(paused);
    await run.handBack();
    assert.equal(await paused, "handed-back");
  }
  assert.deepEqual(await run.requestTakeOver(), { ok: false, refused: "exhausted" });
  execution.end();
  await run.finish(ok());
});

// A step's expired deadline (ADR 0147): the run pauses on its own, as if Take
// over had been pressed at that point, through the same pause.
test("an expired deadline pauses a manual run with no Take over, and Hand back resumes it", async () => {
  const { run, taskRunId, execution, published, timers } = await runningManual();
  const paused = run.interventionSafePoint(run.signal, "deadline");
  assert.equal(await settledOrNot(paused), "unsettled", "the workflow waits at its deadline");
  assert.equal(run.intervention(), "paused");
  assert.equal(published()?.intervention, "paused", "the card hears the run needs the person");
  assert.equal(timers.pending(), 1, "the 5 minutes start with the pause");
  assert.equal(await run.handBack(), true);
  assert.equal(await paused, "handed-back");
  assert.equal(run.intervention(), null);
  // Nobody pressed Take over, so the record says only that the run paused.
  assert.deepEqual(await interventionActions(taskRunId), ["paused", "handed-back"]);
  assert.deepEqual(await storedSignals(taskRunId), ["run-intervention-paused", "run-intervention-handed-back"]);
  execution.end();
  await run.finish(ok());
  assert.equal((await persistence.taskRunById(taskRunId))?.status, "completed");
});

test("an expired deadline takes up a Take over still waiting, and pauses once", async () => {
  const { run, taskRunId, execution } = await runningManual();
  assert.deepEqual(await run.requestTakeOver(), { ok: true });
  const paused = run.interventionSafePoint(run.signal, "deadline");
  await settledOrNot(paused);
  assert.equal(run.intervention(), "paused");
  await run.handBack();
  assert.equal(await paused, "handed-back");
  assert.deepEqual(await interventionActions(taskRunId), ["take-over", "paused", "handed-back"]);
  execution.end();
  await run.finish(ok());
});

test("five minutes paused at a deadline without the person end the run with a User-action Failure", async () => {
  const { run, taskRunId, execution, timers } = await runningManual();
  const paused = run.interventionSafePoint(run.signal, "deadline");
  await settledOrNot(paused);
  timers.advance(5 * 60_000);
  assert.equal(await paused, "timed-out");
  execution.end();
  await run.finish(fail("run-intervention-timed-out"));
  const finished = await persistence.taskRunById(taskRunId);
  assert.equal(finished?.appWorkflowOutcome?.errorCode, "run-intervention-timed-out");
  assert.deepEqual(finished?.interventionLog?.map((entry) => entry.action), ["paused", "timed-out"]);
});

test("an expired deadline never pauses a scheduled run, a Verification Stage, or a run that is not running", async () => {
  const scheduled = await open({ taskId: "sinopac-statements", scheduledAtUtc: "2026-11-22T01:00:00.000Z" });
  await scheduled.run.transition("running");
  assert.equal(await scheduled.run.interventionSafePoint(scheduled.run.signal, "deadline"), null);
  assert.equal(scheduled.run.intervention(), null);
  await scheduled.run.finish(fail("authentication-timeout"));
  assert.deepEqual(await interventionActions(scheduled.taskRunId), [], "a refusal records nothing");
  assert.deepEqual(await storedSignals(scheduled.taskRunId), []);

  const { run, taskRunId, execution } = await runningManual();
  await run.transition("waiting_for_human");
  // A timeout inside a Verification Stage stays the solver's failure (ADR 0039).
  assert.equal(await run.interventionSafePoint(run.signal, "deadline"), null);
  assert.equal(run.intervention(), null);
  await run.transition("running");
  await run.requestStop("cancelled");
  assert.equal(await run.interventionSafePoint(new AbortController().signal, "deadline"), null, "a stopping run fails as before");
  execution.end();
  await run.finish(fail("cancelled"));
  assert.deepEqual(await interventionActions(taskRunId), []);
});

test("deadline pauses and Take over pauses share one cap: one pause and three more", async () => {
  const { run, execution } = await runningManual();
  for (const at of ["deadline", "safe-point", "deadline", "deadline"] as const) {
    if (at === "safe-point") assert.deepEqual(await run.requestTakeOver(), { ok: true });
    const paused = run.interventionSafePoint(run.signal, at);
    await settledOrNot(paused);
    assert.equal(run.intervention(), "paused", `the ${at} pause`);
    await run.handBack();
    assert.equal(await paused, "handed-back");
  }
  assert.equal(await run.interventionSafePoint(run.signal, "deadline"), null, "a fourth further pause is refused, so the step fails");
  assert.equal(run.intervention(), null);
  assert.deepEqual(await run.requestTakeOver(), { ok: false, refused: "exhausted" });
  execution.end();
  await run.finish(fail("authentication-timeout"));
});
