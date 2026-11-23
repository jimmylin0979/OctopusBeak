import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * ADR 0147: a browser source's collection waits for the page through the
 * shared expected-page-state wait (`expectPageState`), so an expired wait
 * pauses a manual run instead of failing it. This guard finds every raw page
 * wait left in the workflow code and fails on one nobody has classified: a
 * new raw wait must either move onto the shared wait or be listed here with
 * the reason it stays raw.
 *
 * A raw wait is a Playwright `waitFor…` call, a frame scope's `until`,
 * `scopeWith`, `firstVisible`, `frame` or `settle`, or a hand-rolled
 * `Date.now() + …` deadline. Fixed pauses and Playwright's own actionability
 * waits inside a click are not page-state waits.
 */
const RAW_WAIT =
  /\.waitFor[A-Za-z]*\(|\.until\(|\.scopeWith\(|\.firstVisible\(|\.frame\((?!\s*\{)|\.settle\(|Date\.now\(\) \+/u;

/** The modules that define the waits themselves. */
const WAIT_MODULES = new Set(["frame-scope.ts", "page-state-wait.ts"]);

type Classified = Readonly<{
  /** Text on the line of the wait; every line it is on must be classified. */
  match: string;
  /** How many lines it is on; default 1. */
  count?: number;
  reason: string;
}>;

/** Why a raw wait stays raw. */
const SIGN_IN = "Source sign-in, whose own deadline is the intervention point (ADR 0147)";
const OPTIONAL = "an optional wait expected to time out (the ifFound pattern)";
const REPLY = "a provider reply or the event a one-time action causes; probing it again would send the request again";
const VERIFICATION = "a Verification Stage wait, which stays solver-only (ADR 0039)";
const DEVICE_REGISTRATION = "device registration, outside collection";
const SETTLE = "a best-effort load settle whose timeout is swallowed; the expected-page-state wait after it decides";

const CLASSIFIED: Readonly<Record<string, readonly Classified[]>> = {
  "browser-interaction.ts": [
    { match: 'waitFor({ state: "attached"', reason: `${OPTIONAL}: hasAttachedLocator answers false on timeout` },
  ],
  "cathay-attached-preview-page.ts": [
    { match: "page.waitForFunction(settles", reason: `${OPTIONAL}: an attached preview's settle leaves the read to decide` },
    { match: "latest.settle(", reason: REPLY },
  ],
  "cathay-device-registration.ts": [
    { match: "Date.now() + timeoutMs", reason: DEVICE_REGISTRATION },
    { match: "page.waitForTimeout(250)", reason: DEVICE_REGISTRATION },
    { match: 'prompt.waitFor({ state: "visible"', reason: DEVICE_REGISTRATION },
    { match: 'prompt.waitFor({ state: "hidden"', reason: DEVICE_REGISTRATION },
    { match: '#CustID").waitFor', reason: DEVICE_REGISTRATION },
  ],
  "cathay-login.ts": [{ match: '#CustID").waitFor', reason: SIGN_IN }],
  "cathay-statements.ts": [
    { match: "Date.now() + timeoutMs", reason: `${SIGN_IN}: startup announcements are dismissed until they stop` },
    { match: "cathayTrustDevicePrompt(page).waitFor", reason: SIGN_IN },
    { match: '#CustID").waitFor', reason: SIGN_IN },
  ],
  "ctbc-current-deposit-balances.ts": [
    { match: "page.waitForURL(CTBC_CURRENT_DEPOSIT_BALANCE_PAGE_URL", reason: `${REPLY}: the page the summary click navigates to, inside the reply trigger` },
  ],
  "ctbc-statements.ts": [
    { match: "Date.now() + 60_000", reason: SIGN_IN },
    { match: "firstField.waitFor(", reason: SIGN_IN },
    { match: '.nth(1).waitFor({', reason: SIGN_IN },
    { match: 'name: "登入" }).waitFor({', reason: SIGN_IN },
    { match: 'waitFor({ state: "visible", timeout: 10_000, signal }))', reason: `${OPTIONAL}: an account selector without options falls back to the bootstrap accounts` },
  ],
  "esun-credit-card-statements.ts": [
    { match: `input[name="id"]').waitFor`, reason: SIGN_IN },
    { match: 'page.waitForEvent("popup"', reason: `${REPLY}: the popup the card link's click opens` },
    { match: "currentCredit.settle(", reason: `${REPLY}: the landing page's card summary, which may never come` },
  ],
  "hncb-netbank-site.ts": [
    { match: "frame.waitForNavigation(", reason: `${REPLY}: the post the main frame loads` },
    { match: "page.waitForResponse(isDispatcherPost", reason: `${REPLY}: a dispatching menu's POST` },
    { match: "frames.settle(", reason: SETTLE },
  ],
  "hncb-statements.ts": [
    { match: "ifFound(scope.scopeWith(", reason: `${SIGN_IN}: isSignedIn, ${OPTIONAL}` },
    { match: "await site.settle();", count: 2, reason: SETTLE },
    { match: 'page.waitForEvent("popup"', reason: `${REPLY}: the export popup the download link's click opens` },
    { match: '.waitForLoadState("domcontentloaded", { timeout: 10_000', reason: `${OPTIONAL}: the export popup's load; doSubmit is checked next` },
    { match: "scope.until(async () => settled", reason: `${REPLY}: the export reply's deadline` },
  ],
  "post-statements.ts": [
    { match: "closeButton.waitFor(", reason: `${OPTIONAL}: the notice iPost may open over the sign-in form` },
    { match: '#cifID").waitFor(', reason: SIGN_IN },
  ],
  "provider-response-reader.ts": [
    { match: "scope.page.waitForResponse(", reason: `${REPLY}: the reader's own reply wait` },
    { match: "options.waitFor(reply)", reason: "not a wait: the caller's reply predicate" },
  ],
  "sign-in.ts": [
    { match: "deadline = Date.now() + timeoutMs", count: 4, reason: SIGN_IN },
    { match: "const deadline = Date.now() + ms", reason: SIGN_IN },
    { match: 'waitFor({ state: "visible", timeout: ms })', reason: SIGN_IN },
    { match: 'waitFor({ state: "hidden", timeout: PROMPT_HIDDEN_MS })', reason: SIGN_IN },
  ],
  "sinopac-mma-site.ts": [
    { match: "frames.settle()", reason: SETTLE },
  ],
  "sinopac-statements.ts": [
    { match: 'dismiss.waitFor({ state: "hidden"', reason: `${SIGN_IN}: the password expiry notice, ${OPTIONAL}` },
    { match: 'waitForLoadState("domcontentloaded", { timeout: 10_000', reason: `${SIGN_IN}: the password expiry notice, ${OPTIONAL}` },
    { match: 'page.waitForLoadState("domcontentloaded", { timeout: 60_000', reason: SIGN_IN },
    { match: 'form#aspnetForm").waitFor(', reason: SIGN_IN },
    { match: '.waitFor({ state: "visible", timeout: 10_000, signal })', reason: `${SIGN_IN}: the session probe, ${OPTIONAL}` },
  ],
};

/** Sources still moving onto the shared wait in their own tickets: at most this many raw waits each, until then. */
const PENDING: Readonly<Record<string, Readonly<{ atMost: number; ticket: string }>>> = {
  "fubon-all-statements.ts": { atMost: 1, ticket: "#9" },
  "fubon-auth.ts": { atMost: 12, ticket: "#9" },
  "fubon-credit-card-statements.ts": { atMost: 10, ticket: "#9" },
  "fubon-current-deposit-balances.ts": { atMost: 4, ticket: "#9" },
  "fubon-ebank-site.ts": { atMost: 4, ticket: "#9" },
  "fubon-loan-statements.ts": { atMost: 12, ticket: "#9" },
  "fubon-statements.ts": { atMost: 6, ticket: "#9" },
  "yuanta-auth.ts": { atMost: 6, ticket: "#10" },
  "yuanta-credit-card-statements.ts": { atMost: 10, ticket: "#10" },
  "yuanta-current-deposit-balances.ts": { atMost: 3, ticket: "#10" },
  "yuanta-ebank-site.ts": { atMost: 8, ticket: "#10" },
  "yuanta-foreign-currency-statements.ts": { atMost: 13, ticket: "#10" },
  "yuanta-fund-statements.ts": { atMost: 5, ticket: "#10" },
  "yuanta-loan-statements.ts": { atMost: 8, ticket: "#10" },
  "yuanta-statements.ts": { atMost: 6, ticket: "#10" },
  "yuanta-trade-statements.ts": { atMost: 7, ticket: "#10" },
};

const WORKFLOWS = new URL(".", import.meta.url);

/** Each workflow module's raw-wait lines, keyed by file name. */
function rawWaits(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of readdirSync(WORKFLOWS).sort()) {
    if (!file.endsWith(".ts") || /\.(?:check|fixtures)\.ts$/u.test(file) || WAIT_MODULES.has(file)) continue;
    const lines = readFileSync(new URL(file, WORKFLOWS), "utf8").split("\n").filter((line) => RAW_WAIT.test(line));
    if (lines.length > 0) found.set(file, lines);
  }
  return found;
}

test("every raw page wait in a browser source's workflow is classified; collection waits use the shared wait (ADR 0147)", () => {
  const found = rawWaits();
  const problems: string[] = [];
  for (const [file, lines] of found) {
    const pending = PENDING[file];
    if (pending) {
      if (lines.length > pending.atMost)
        problems.push(`${file}: ${lines.length} raw waits, more than the ${pending.atMost} left for ${pending.ticket}`);
      continue;
    }
    const entries = CLASSIFIED[file] ?? [];
    for (const line of lines) {
      if (!entries.some((entry) => line.includes(entry.match)))
        problems.push(`${file}: an unclassified raw wait; use expectPageState or classify it: ${line.trim()}`);
    }
  }
  for (const [file, entries] of Object.entries(CLASSIFIED)) {
    const lines = found.get(file) ?? [];
    for (const entry of entries) {
      const count = lines.filter((line) => line.includes(entry.match)).length;
      if (count !== (entry.count ?? 1))
        problems.push(`${file}: "${entry.match}" is on ${count} raw-wait lines, not ${entry.count ?? 1}; update the classification`);
    }
  }
  assert.deepEqual(problems, []);
});

test("collection waits left raw are each given a reason, never a placeholder", () => {
  const placeholders = Object.entries(CLASSIFIED).flatMap(([file, entries]) =>
    entries.filter((entry) => entry.reason.startsWith("TODO")).map((entry) => `${file}: ${entry.match}`));
  assert.deepEqual(placeholders, []);
});
