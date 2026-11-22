import assert from "node:assert/strict";
import test from "node:test";
import {
  hasValidRunEventMeaning,
  isValidRunStop,
  legacyRunEventOutcome,
  runStopFor,
  runStopPageLocation,
  RUN_EVENT_SIGNALS,
  signalRunEvent,
  upgradeStoredRunEvent,
  type RunEventSignal,
} from "./run-event.ts";

const detail = { runId: "run-1", occurredAt: "2026-10-23T00:00:00.000Z" };

test("a stored code takes the outcome the old suffix patterns gave it, failure first and cancellation as progress", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["source-decoding-failed", "failed"],
    ["source-validation-rejected", "failed"],
    ["source-response-malformed", "failed"],
    ["servisign-unavailable", "failed"],
    ["run-cancelled", "advanced"],
    ["canonical-commit-cancelled", "advanced"],
    ["collection-failed", "failed"],
    ["authentication-completed", "completed"],
    ["account-collected", "completed"],
    ["account-no-data", "completed"],
    ["input-validated", "completed"],
    ["canonical-admission-completed", "completed"],
    ["authentication-started", "started"],
    ["progress-update", "advanced"],
    ["device-registration-required", "advanced"],
  ];
  for (const [code, outcome] of cases) assert.equal(legacyRunEventOutcome(code), outcome, code);
});

test("a stored signal code becomes its signal only at the signal's stage", () => {
  assert.deepEqual(
    upgradeStoredRunEvent({ ...detail, stage: "authentication", code: "verification-solver-exhausted" }),
    { ...detail, stage: "authentication", code: "verification-solver-exhausted", outcome: "failed", signal: "verification-solver-exhausted" },
  );
  const misplaced = upgradeStoredRunEvent({ ...detail, stage: "collection", code: "verification-solver-exhausted" });
  assert.deepEqual(misplaced, { ...detail, stage: "collection", code: "verification-solver-exhausted", outcome: "failed" });
  assert.equal(hasValidRunEventMeaning(misplaced as Record<string, unknown>), false);
});

test("an event that already states its outcome is not reinterpreted", () => {
  const event = { ...detail, stage: "collection", outcome: "advanced", code: "account-collected" };
  assert.equal(upgradeStoredRunEvent(event), event);
});

test("every signal event fixes its stage, outcome and code", () => {
  for (const signal of Object.keys(RUN_EVENT_SIGNALS) as RunEventSignal[]) {
    const event = signalRunEvent(signal, detail);
    assert.equal(event.stage, RUN_EVENT_SIGNALS[signal].stage);
    assert.equal(event.outcome, RUN_EVENT_SIGNALS[signal].outcome);
    assert.equal(event.code, signal);
    assert.equal(hasValidRunEventMeaning(event), true, signal);
  }
});

test("a boundary rejects an outcome outside the closed set and a signal that disagrees", () => {
  const plain = { ...detail, stage: "collection", outcome: "completed", code: "collection-completed" };
  assert.equal(hasValidRunEventMeaning(plain), true);
  assert.equal(hasValidRunEventMeaning({ ...plain, outcome: "rejected" }), false);
  assert.equal(hasValidRunEventMeaning({ ...plain, outcome: undefined }), false);
  assert.equal(hasValidRunEventMeaning({ ...plain, signal: "not-a-signal" }), false);
  const exhausted = signalRunEvent("verification-solver-exhausted", detail);
  assert.equal(hasValidRunEventMeaning({ ...exhausted, outcome: "completed" }), false);
  assert.equal(hasValidRunEventMeaning({ ...exhausted, code: "other-code" }), false);
  assert.equal(hasValidRunEventMeaning({ ...exhausted, signal: undefined }), false);
});

test("a stopped page keeps only its host and path, never the query or fragment", () => {
  assert.deepEqual(
    runStopPageLocation("https://Bank.Example/a/b;jsessionid=X1?token=SECRET#frag"),
    { host: "bank.example", path: "/a/b" },
  );
  assert.deepEqual(runStopPageLocation("http://bank.example"), { host: "bank.example", path: "/" });
  // A long digit run in the path can be an account number, so it is masked.
  assert.deepEqual(
    runStopPageLocation("https://bank.example/acct/0123456789/detail?x=1"),
    { host: "bank.example", path: "/acct/*/detail" },
  );
  assert.deepEqual(runStopPageLocation("https://bank.example/v2/page-12345"), { host: "bank.example", path: "/v2/page-12345" });
  assert.equal(runStopPageLocation(`https://bank.example/${"a".repeat(400)}`)?.path.length, 200);
});

test("a page that is not a web page never becomes a location, and user info is dropped", () => {
  for (const url of [
    "about:blank",
    "data:text/html,<p>BALANCE 12,345</p>",
    "chrome-error://chromewebdata/",
    "file:///etc/passwd",
    "not a url",
    "",
  ]) assert.equal(runStopPageLocation(url), null, url);
  assert.deepEqual(runStopPageLocation("https://user:pass@bank.example/login"), { host: "bank.example", path: "/login" });
});

test("a run stop names its step and the kind of page it stopped on", () => {
  assert.deepEqual(
    runStopFor({ step: "login-submitted", timedOut: true, url: "https://bank.example/login?next=/home" }),
    { step: "login-submitted", page: { kind: "step-wait-timeout", host: "bank.example", path: "/login" } },
  );
  assert.deepEqual(
    runStopFor({ step: "statement-query-started", timedOut: false, url: "https://bank.example/stmt" }),
    { step: "statement-query-started", page: { kind: "url", host: "bank.example", path: "/stmt" } },
  );
  assert.deepEqual(
    runStopFor({ step: "run-started", timedOut: true, url: null }),
    { step: "run-started", page: { kind: "step-wait-timeout" } },
  );
  assert.deepEqual(runStopFor({ step: "run-started", timedOut: false, url: "about:blank" }), { step: "run-started" });
  assert.equal(runStopFor({ step: "Not A Code", timedOut: false, url: null }), undefined);
});

test("a boundary accepts only a run stop of the fixed shape", () => {
  assert.equal(isValidRunStop({ step: "login-submitted" }), true);
  assert.equal(isValidRunStop({ step: "login-submitted", page: { kind: "url", host: "bank.example", path: "/login" } }), true);
  assert.equal(isValidRunStop({ step: "login-submitted", page: { kind: "step-wait-timeout" } }), true);
  for (const value of [
    null,
    "login-submitted",
    { step: "Login Submitted" },
    { step: "login-submitted", page: { kind: "url", host: "bank.example", path: "/login?token=SECRET" } },
    { step: "login-submitted", page: { kind: "url", host: "bank.example", path: "/login#frag" } },
    { step: "login-submitted", page: { kind: "url", host: "bank.example", path: "/acct/0123456789" } },
    { step: "login-submitted", page: { kind: "url", path: "/login" } },
    { step: "login-submitted", page: { kind: "dialog" } },
    { step: "login-submitted", page: { kind: "url", host: "bank.example", path: "/login", text: "BALANCE" } },
    { step: "login-submitted", screenshot: "iVBORw0KGgo=" },
  ]) assert.equal(isValidRunStop(value), false, JSON.stringify(value));
});

test("only a failed event may carry a run stop, and only a valid one", () => {
  const failed = { ...detail, stage: "finalization", outcome: "failed", code: "run-failed" };
  assert.equal(hasValidRunEventMeaning({ ...failed, stoppedAt: { step: "login-submitted" } }), true);
  assert.equal(hasValidRunEventMeaning({ ...failed, stoppedAt: { step: "login-submitted", page: { kind: "url", host: "b.example", path: "/?q=1" } } }), false);
  assert.equal(hasValidRunEventMeaning({ ...failed, outcome: "advanced", code: "run-cancelled", stoppedAt: { step: "login-submitted" } }), false);
});
