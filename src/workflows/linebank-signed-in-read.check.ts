import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type Browser, type Page } from "playwright";
import { launchCheckBrowser } from "../lib/automation/check-browser.fixtures.ts";
import { productCollectionHandle } from "../lib/automation/product-collection.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { frameScope } from "./frame-scope.ts";
import { LineBankApiClient, linebankAutoDismissApprovedAlert, linebankEnsureTransactionPage } from "./linebank-statements.ts";

const CANCELLED = new Error("synthetic cancellation");
const ORIGIN = "https://accessibility.linebank.com.tw";

let browser: Browser;
before(async () => {
  browser = await launchCheckBrowser();
});
after(async () => {
  await browser.close();
});

/**
 * Every LINE Bank page loads but never renders the account dropdown, and its API never answers.
 * The home page's transaction link accepts clicks only after 600 ms.
 */
async function withSilentLineBank(body: (page: Page) => Promise<void>): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.route(`${ORIGIN}/v1/**`, () => undefined);
    await page.route(`${ORIGIN}/`, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<a href="/transaction" id="late" style="pointer-events: none">帳戶交易明細查詢</a><p>載入中</p>`,
      }));
    await page.route(`${ORIGIN}/transaction`, (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: "<p>載入中</p>" }));
    await body(page);
  } finally {
    await page.close();
  }
}

const scopeCancelledAfter = (page: Page, ms: number) => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(CANCELLED), ms);
  return frameScope(page, controller.signal);
};

const settlesWithin = async (read: Promise<unknown>) => {
  const started = Date.now();
  await assert.rejects(read, (error: unknown) => error === CANCELLED);
  return Date.now() - started;
};

test("cancelling the run stops the transaction page waiting two minutes for the account dropdown", () =>
  withSilentLineBank(async (page) => {
    await page.goto(`${ORIGIN}/transaction`);
    assert.ok((await settlesWithin(linebankEnsureTransactionPage(scopeCancelledAfter(page, 300)))) < 2_000);
  }));

test("the account dropdown is a Run intervention safe point (ADR 0147)", () =>
  withSilentLineBank(async (page) => {
    await page.goto(`${ORIGIN}/transaction`);
    const consulted: string[] = [];
    await linebankEnsureTransactionPage(frameScope(page, new AbortController().signal), {
      // The person brings the dropdown up, as during a Take over.
      safePoint: async () => {
        consulted.push("safe-point");
        await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", `<div id="account-dropdown">帳戶</div>`));
        return "none";
      },
      deadlineExpired: async () => assert.fail("the dropdown appeared before the deadline"),
    });
    assert.deepEqual(consulted, ["safe-point"]);
  }));

test("a dismissed alert that stays up is a Run intervention safe point (ADR 0147)", () =>
  withSilentLineBank(async (page) => {
    await page.goto(`${ORIGIN}/transaction`);
    await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", `<div role="alertdialog" id="alert"><button>確定</button></div>`));
    const consulted: string[] = [];
    const dismissed = await linebankAutoDismissApprovedAlert(frameScope(page, new AbortController().signal), {
      safePoint: async () => {
        consulted.push("safe-point");
        await page.evaluate(() => document.getElementById("alert")!.remove());
        return "none";
      },
      deadlineExpired: async () => assert.fail("the alert closed before the deadline"),
    });
    assert.equal(dismissed, true);
    assert.deepEqual(consulted, ["safe-point"]);
  }));

test("cancelling the run stops the transaction link click, which never lands", () =>
  withSilentLineBank(async (page) => {
    await page.goto(`${ORIGIN}/`);
    const scope = scopeCancelledAfter(page, 300);
    await page.evaluate(() => {
      setTimeout(() => { document.getElementById("late")!.style.pointerEvents = ""; }, 600);
    });
    assert.ok((await settlesWithin(linebankEnsureTransactionPage(scope))) < 2_000);
    await page.waitForTimeout(800);
    assert.equal(new URL(page.url()).pathname, "/", "the cancelled click did not navigate later");
  }));

test("cancelling the run abandons an account snapshot whose fetch never answers", () =>
  withSilentLineBank(async (page) => {
    await page.goto(`${ORIGIN}/transaction`);
    const client = new LineBankApiClient(scopeCancelledAfter(page, 300), productCollectionHandle({
      now: () => new Date().toISOString(),
      text: strictSourceText,
      signal: new AbortController().signal,
      event: async () => undefined,
      stage: () => undefined,
      reportActivity: async () => undefined,
      collectionPeriod: () => { throw new Error("This check supplies no collection period."); },
    }));
    assert.ok((await settlesWithin(client.fetchAccountSnapshot())) < 2_000);
  }));
