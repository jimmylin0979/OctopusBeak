import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type Browser, type Page } from "playwright";
import { launchCheckBrowser } from "../lib/automation/check-browser.fixtures.ts";
import { productCollectionHandle, type ProductStageRequest } from "../lib/automation/product-collection.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } from "../ledger/canonical/current-deposit-route-contracts.ts";
import { readCtbcCurrentDepositBalanceResponse } from "./ctbc-current-deposit-balances.ts";
import { readCtbcDepositSource } from "./ctbc-statements.ts";
import { FrameScopeTimeoutError } from "./frame-scope.ts";
import { sourceReader } from "./provider-response-reader.ts";

const CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["ctbc/domestic-deposit/current-balance-v1"];

const CANCELLED = new Error("synthetic cancellation");
const ABORT_AFTER_MS = 300;
const UNCOVERED_AFTER_MS = 700;

let browser: Browser;
before(async () => {
  browser = await launchCheckBrowser();
});
after(async () => {
  await browser.close();
});

/**
 * A CTBC page whose control stays covered until after the run is cancelled.
 * A click still pending then would land; a stopped one never does.
 */
const coveredControlPage = (control: string) => `<!doctype html>
<meta charset="utf-8">
${control}
<div id="cover" style="position:fixed;inset:0;background:white"></div>
<script>
  window.clicks = 0;
  document.querySelector("[data-control]").addEventListener("click", () => { window.clicks += 1; });
  setTimeout(() => document.getElementById("cover").remove(), ${UNCOVERED_AFTER_MS});
  for (const resource of ["/twrbc-deposit/qu002/010", "/twrbc-deposit/qu002/011"]) {
    fetch("${CONTRACT.endpointPath}", { method: "POST", body: JSON.stringify({ resource }) });
  }
</script>`;

const resources: Record<string, unknown> = {
  "/twrbc-deposit/qu002/010": { code: "0000", rsData: { accountInfoList: [{ accountId: "synthetic" }], dateRanges: [] } },
  "/twrbc-deposit/qu002/011": { code: "9201", rsData: null },
};

async function withCtbc(control: string, body: (page: Page) => Promise<void>): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.route(`https://${CONTRACT.endpointHost}/**`, (route) => {
      const request = route.request();
      if (request.method() !== "POST") {
        return route.fulfill({ contentType: "text/html; charset=utf-8", body: coveredControlPage(control) });
      }
      const { resource } = JSON.parse(request.postData() ?? "{}") as { resource: string };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(resources[resource]) });
    });
    await body(page);
  } finally {
    await page.close();
  }
}

const cancelledAfter = (ms: number) => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(CANCELLED), ms);
  return controller.signal;
};

/** The read rejects with the run's reason well inside its wait, and the pending click never lands. */
async function assertStopped(page: Page, read: Promise<unknown>) {
  const started = Date.now();
  await assert.rejects(read, (error: unknown) => error === CANCELLED);
  assert.ok(Date.now() - started < 2_000);
  await new Promise((resolve) => setTimeout(resolve, UNCOVERED_AFTER_MS + 500));
  assert.equal(await page.evaluate(() => (window as unknown as { clicks: number }).clicks), 0);
}

test("cancelling the run stops a deposit read clicking the account selector", () =>
  withCtbc(`<div class="btn dropdown-toggle" data-control>帳戶</div>`, async (page) => {
    const staged: ProductStageRequest[] = [];
    const signal = cancelledAfter(ABORT_AFTER_MS);
    const now = () => new Date().toISOString();
    const event = async () => undefined;
    const context = { signal, text: strictSourceText, now, event } as unknown as WorkflowContext;
    const product = productCollectionHandle({
      now,
      text: strictSourceText,
      signal,
      event,
      stage: (...requests) => { staged.push(...requests); },
      reportActivity: async () => undefined,
      collectionPeriod: () => { throw new Error("This check supplies no collection period."); },
    });
    await assertStopped(page, readCtbcDepositSource(page, {
      credentials: { ctbc_user_id: "synthetic-user", ctbc_account: "synthetic-account", ctbc_password: "synthetic-password" },
      statementTypes: ["deposit"],
      attachedPreviewProducts: [],
    }, context, product));
    assert.deepEqual(staged, []);
  }));

test("cancelling the run stops a current-balance read clicking its menu", () =>
  withCtbc(`<a data-control>臺幣/轉帳</a>`, async (page) => {
    await page.goto(`https://${CONTRACT.endpointHost}/twrbc/`);
    const reader = sourceReader({
      now: () => new Date().toISOString(),
      text: strictSourceText,
    });
    await assertStopped(page, readCtbcCurrentDepositBalanceResponse(page, cancelledAfter(ABORT_AFTER_MS), reader));
  }));

const productFor = (signal: AbortSignal) => {
  const now = () => new Date().toISOString();
  return productCollectionHandle({
    now,
    text: strictSourceText,
    signal,
    event: async () => undefined,
    stage: () => assert.fail("a stopped read stages nothing"),
    reportActivity: async () => undefined,
    collectionPeriod: () => { throw new Error("This check supplies no collection period."); },
  });
};

test("CTBC's month tabs are a Run intervention safe point (ADR 0147)", () =>
  withCtbc(`<div data-control></div>`, async (page) => {
    const controller = new AbortController();
    const consulted: string[] = [];
    const intervention = {
      // The person brings up the month tabs, as during a Take over.
      safePoint: async () => {
        if (consulted.length === 0) {
          await page.evaluate(() => {
            for (const month of ["2026/11", "2026/10"]) {
              const tab = document.createElement("a");
              tab.className = "nav-link";
              tab.textContent = month;
              tab.onclick = () => { document.body.dataset.tab = month; };
              document.body.append(tab);
            }
          });
        }
        consulted.push("safe-point");
        return "none" as const;
      },
      deadlineExpired: async () => assert.fail("the tabs appeared before the deadline"),
    };
    const context = { signal: controller.signal, text: strictSourceText, now: () => new Date().toISOString(), event: async () => undefined, intervention } as unknown as WorkflowContext;
    const read = readCtbcDepositSource(page, {
      credentials: { ctbc_user_id: "synthetic-user", ctbc_account: "synthetic-account", ctbc_password: "synthetic-password" },
      statementTypes: ["deposit"],
      attachedPreviewProducts: [],
    }, context, productFor(controller.signal));
    read.catch(() => undefined);
    // The second month's tab is clicked once the wait has found the tabs; its reply never comes.
    await page.waitForFunction(() => document.body.dataset.tab === "2026/10", undefined, { timeout: 10_000 });
    controller.abort(CANCELLED);
    await assert.rejects(read, (error: unknown) => error === CANCELLED);
    assert.ok(consulted.length > 0, "the tabs' wait is a safe point");
  }));

test("CTBC's balance menu pauses a manual run at its deadline; a scheduled run fails with a step-wait timeout (ADR 0147)", () =>
  withCtbc(`<div data-control></div>`, async (page) => {
    await page.goto(`https://${CONTRACT.endpointHost}/twrbc/`);
    const reader = sourceReader({ now: () => new Date().toISOString(), text: strictSourceText });
    const controller = new AbortController();
    let deadlines = 0;
    const handedBack = readCtbcCurrentDepositBalanceResponse(page, controller.signal, reader, {
      timeoutMs: 300,
      intervention: {
        safePoint: async () => "none",
        deadlineExpired: async () => {
          deadlines += 1;
          await page.evaluate(() => {
            const menu = document.createElement("a");
            menu.textContent = "臺幣/轉帳";
            menu.onclick = () => {
              const summary = document.createElement("a");
              summary.textContent = "臺幣存款概要";
              summary.onclick = () => { document.body.dataset.summary = "yes"; };
              document.body.append(summary);
            };
            document.body.append(menu);
          });
          return "handed-back";
        },
      },
    });
    handedBack.catch(() => undefined);
    await page.waitForFunction(() => document.body.dataset.summary === "yes", undefined, { timeout: 10_000 });
    controller.abort(CANCELLED);
    await assert.rejects(handedBack, (error: unknown) => error === CANCELLED);
    assert.equal(deadlines, 1, "after Hand back the menu is walked to the summary");

    await page.reload();
    for (const intervention of [{ safePoint: async () => "none" as const, deadlineExpired: async () => "none" as const }, undefined]) {
      await assert.rejects(
        readCtbcCurrentDepositBalanceResponse(page, new AbortController().signal, reader, {
          timeoutMs: 300,
          ...(intervention ? { intervention } : {}),
        }),
        (error: unknown) => error instanceof FrameScopeTimeoutError && /臺幣\/轉帳/u.test(error.message),
      );
    }
  }));
