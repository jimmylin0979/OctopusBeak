import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { chromium, type Browser, type Page } from "playwright";
import { createPgliteOperationalStore } from "../src/ledger/pglite/operational.ts";
import { PGliteStore } from "../src/ledger/pglite/transaction.ts";
import {
  removeDesktopCdpFixture,
  seedDesktopCdpFixture,
} from "../scripts/seed-desktop-cdp-fixture.ts";
import {
  RUN_INTERVENTION_FIXTURE_TASK_ID as TASK_ID,
  RUN_INTERVENTION_FIXTURE_URL_ENV,
} from "../src/lib/automation/server/run-intervention-fixture.ts";

/**
 * Electron/CDP check of the Run live view and Run intervention (ADR 0147).
 * A loopback page shows an overlay over the element the fixture step expects.
 * No bank, no credentials: the fixture source is test-only and the launch is
 * the disposable CDP fixture, which never touches a person's ledger.
 */

/** Text that appears on the page, in what a person types, and in the query: none may reach disk. */
const PAGE_MARKER = "BALANCE-MARKER-4471";
const TYPED_MARKER = "typed-marker-9921";
const QUERY_MARKER = "query-marker-3350";

/** The overlay's Close button and input, in the page's CSS pixels (the viewport is 1280x900). */
const CLOSE_BUTTON = { x: 200, y: 150 };
const INPUT_FIELD = { x: 250, y: 240 };

const PAGE_HTML = `<!doctype html><meta charset="utf-8"><title>Fixture bank</title>
<body style="margin:0;font:20px sans-serif;background:#eef">
<main id="fixture-target" style="padding:24px">Account overview <b>${PAGE_MARKER}</b></main>
<div id="fixture-overlay" style="position:fixed;inset:0;background:#fffc;z-index:10">
  <button id="close" style="position:absolute;left:100px;top:120px;width:200px;height:60px;font-size:24px">Close</button>
  <input id="field" style="position:absolute;left:100px;top:220px;width:300px;height:40px;font-size:20px">
</div>
<script>
  document.getElementById("close").addEventListener("click", () => {
    const length = document.getElementById("field").value.length;
    document.getElementById("fixture-overlay").remove();
    fetch("/closed?length=" + length);
  });
</script></body>`;

type FixturePage = Readonly<{
  url: string;
  closed(): ReadonlyArray<{ length: number }>;
  visits(): number;
  stop(): Promise<void>;
}>;

async function startFixturePage(): Promise<FixturePage> {
  const closed: Array<{ length: number }> = [];
  let visits = 0;
  const server: Server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/closed") {
      closed.push({ length: Number(url.searchParams.get("length")) });
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === "/bank/overview") {
      visits += 1;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE_HTML);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start the fixture page.");
  return {
    url: `http://127.0.0.1:${address.port}/bank/overview?token=${QUERY_MARKER}`,
    closed: () => closed,
    visits: () => visits,
    stop: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

async function reserveCdpPort() {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a local CDP port.");
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function redacted(value: string, directory: string) {
  return value.replaceAll(directory, "<TEMP>").trim().slice(-2_000);
}

async function waitForCdpEndpoint(cdpUrl: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const metadata = await response.json() as { webSocketDebuggerUrl?: unknown };
        if (typeof metadata.webSocketDebuggerUrl === "string") return metadata.webSocketDebuggerUrl;
      }
    } catch {
      // Electron has not opened the debugging endpoint yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Electron CDP endpoint did not become available.");
}

async function waitForRendererPage(browser: Browser, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Electron CDP renderer page did not become available.");
}

async function navigateToAutomation(page: Page) {
  await page.waitForFunction(
    () => window.location.hash === "#/overview"
      && Boolean(document.querySelector('nav.side-nav a[href="#/automation"]')),
    undefined,
    { timeout: 15_000 },
  );
  await page.locator('nav.side-nav a[href="#/automation"]').click();
  await page.waitForFunction(() => window.location.hash === "#/automation", undefined, { timeout: 10_000 });
}

/** Poll an async renderer-side predicate; Playwright's waitForFunction does not await it here. */
async function waitForRenderer<Arg>(
  page: Page,
  predicate: (arg: Arg) => boolean | Promise<boolean>,
  arg: Arg,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await page.evaluate(predicate as never, arg) as boolean) return;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}.`);
    await page.waitForTimeout(100);
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() && statSync(path).size > 0 ? [path] : [];
  });
}

/** A JPEG screencast frame starts FF D8 FF; none may ever be written under user data. */
function assertNothingVisualOrTypedOnDisk(userData: string) {
  const needles = [PAGE_MARKER, TYPED_MARKER, QUERY_MARKER].map((marker) => Buffer.from(marker));
  for (const file of filesUnder(userData)) {
    const bytes = readFileSync(file);
    for (const needle of needles) {
      assert.equal(bytes.includes(needle), false, `${needle.toString()} reached ${file.replace(userData, "<USER-DATA>")}`);
    }
    assert.equal(bytes.includes(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), false, `a JPEG frame reached ${file.replace(userData, "<USER-DATA>")}`);
    assert.equal(bytes.includes(Buffer.from([0xff, 0xd8, 0xff, 0xdb])), false, `a JPEG frame reached ${file.replace(userData, "<USER-DATA>")}`);
  }
}

type RunRecord = NonNullable<Awaited<ReturnType<ReturnType<typeof createPgliteOperationalStore>["taskRunById"]>>>;

/** Read the fixture task's runs from the ledger after Electron has exited. */
async function readTaskRuns(userData: string): Promise<RunRecord[]> {
  const database = await PGlite.create({ dataDir: join(userData, "data", "pglite") });
  try {
    const automation = createPgliteOperationalStore(new PGliteStore(database));
    const history = await automation.recentTaskRuns(50);
    const runs: RunRecord[] = [];
    for (const row of history.filter((candidate) => candidate.taskId === TASK_ID)) {
      const run = await automation.taskRunById(row.taskRunId);
      if (run) runs.push(run);
    }
    return runs;
  } finally {
    await database.close();
  }
}

type Launch = Readonly<{
  directory: string;
  userData: string;
  page: Page;
  /** Quit Electron and wait for it to exit, so the ledger can be read. */
  quit(): Promise<void>;
  cleanup(): Promise<void>;
}>;

async function launchElectron(
  t: test.TestContext,
  fixturePage: FixturePage,
  extraEnvironment: Record<string, string> = {},
): Promise<Launch | null> {
  const directory = mkdtempSync(join(tmpdir(), "octopusbeak-intervention-cdp-"));
  const userData = join(directory, "user-data");
  await seedDesktopCdpFixture(userData, new Date("2026-09-14T04:00:00.000Z"));
  const cdpPort = await reserveCdpPort();
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  const electronPath = createRequire(import.meta.url)("electron") as string;
  const main = fileURLToPath(new URL("./main.cjs", import.meta.url));
  let output = "";
  let errorOutput = "";
  const child: ChildProcess = spawn(
    electronPath,
    ["--no-sandbox", "--disable-gpu", `--user-data-dir=${userData}`, main],
    {
      cwd: directory,
      env: {
        ...process.env,
        OCTOPUSBEAK_CDP_FIXTURE: "171",
        OCTOPUSBEAK_USER_DATA: userData,
        OCTOPUSBEAK_CDP_PORT: String(cdpPort),
        [RUN_INTERVENTION_FIXTURE_URL_ENV]: fixturePage.url,
        ...extraEnvironment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { errorOutput += String(chunk); });
  const exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (status, signal) => resolve({ status, signal }));
    child.once("error", () => resolve({ status: null, signal: null }));
  });
  let browser: Browser | null = null;
  const quit = async () => {
    if (browser) await browser.close().catch(() => {});
    browser = null;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  };
  const cleanup = async () => {
    await quit();
    removeDesktopCdpFixture(directory);
  };
  try {
    const launchResult = await Promise.race([
      waitForCdpEndpoint(cdpUrl, 15_000).then(() => ({ ready: true as const })).catch((error) => {
        throw new Error(`${String(error)} stdout=${redacted(output, directory)} stderr=${redacted(errorOutput, directory)}`);
      }),
      exited.then((result) => ({ ready: false as const, result })),
    ]);
    if (!launchResult.ready) {
      const { result } = launchResult;
      if (process.platform === "darwin" && result.signal === "SIGABRT" && result.status === null
        && output.trim() === "" && errorOutput.trim() === "") {
        t.skip("Electron fixture hit the known macOS NSApplication SIGABRT initialization limitation.");
        await cleanup();
        return null;
      }
      assert.fail(`Electron exited before CDP was ready; stdout=${redacted(output, directory)} stderr=${redacted(errorOutput, directory)}`);
    }
    browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15_000 });
    const page = await waitForRendererPage(browser, 15_000);
    await navigateToAutomation(page);
    return { directory, userData, page, quit, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

const taskRow = (page: Page) => page.locator(`#${TASK_ID}-task-row`);

const runtimeStatus = (page: Page) => page.evaluate(async (taskId) => {
  const snapshot = await window.octopusBeak.automation.runtimeSnapshot();
  const task = snapshot.tasks.find((candidate) => candidate.taskId === taskId);
  return task ? { status: task.status, runId: task.runId } : null;
}, TASK_ID);

test("isolated Electron/CDP manual run: live view, pause, take over, hand back, complete", async (t) => {
  const fixturePage = await startFixturePage();
  const launch = await launchElectron(t, fixturePage);
  if (!launch) { await fixturePage.stop(); return; }
  const { page, userData } = launch;
  try {
    const row = taskRow(page);
    await row.waitFor({ state: "visible", timeout: 15_000 });

    // Remember the live view's id from its frames: the dialog owns the one view, and
    // opening a second would replace it.
    await page.evaluate(() => {
      const target = window as unknown as { __viewProbe: { viewId: string | null; frames: number } };
      target.__viewProbe = { viewId: null, frames: 0 };
      window.octopusBeak.automation.onLiveViewFrame((frame) => {
        target.__viewProbe.viewId = frame.viewId;
        target.__viewProbe.frames += 1;
      });
    });

    // A manual run starts from the card's Run action, through the real renderer.
    await row.locator(".task-actions button[aria-busy]").click();
    const viewButton = row.locator(".live-view-action");
    await viewButton.waitFor({ state: "visible", timeout: 30_000 });
    await viewButton.click();

    // The view is read-only: frames arrive, and no control surface exists.
    const dialog = page.locator("#run-live-view-title").locator("xpath=ancestor::*[@role='dialog'][1]");
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    const frame = dialog.locator("img.live-view-frame");
    await frame.waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await frame.getAttribute("src") ?? "", /^data:image\/jpeg;base64,/u);
    assert.equal(await dialog.locator(".live-view-control").count(), 0, "a running page offers no control");
    await waitForRenderer(page, () => {
      const probe = (window as unknown as { __viewProbe: { frames: number } }).__viewProbe;
      return probe.frames >= 1;
    }, undefined, 10_000, "a live view frame event");

    // Input before the pause is refused: it never reaches the page.
    const viewId = await page.evaluate(() => (window as unknown as { __viewProbe: { viewId: string } }).__viewProbe.viewId);
    assert.ok(viewId, "frames carry the view id");
    const early = await page.evaluate(async (id) => {
      try {
        await window.octopusBeak.automation.interventionInput(id, { type: "click", x: 200, y: 150 });
        return "accepted";
      } catch {
        return "refused";
      }
    }, viewId);
    assert.equal(early, "refused", "input is refused before the run has paused");
    assert.deepEqual(fixturePage.closed(), [], "the refused click did not reach the page's Close button");
    assert.equal(await runtimeStatus(page).then((task) => task?.status), "running", "the run was still running when input was refused");

    // The step's wait times out: the run pauses instead of failing and the card needs the person.
    await row.getByText(/Needs you|需要你處理/u).first().waitFor({ state: "visible", timeout: 30_000 });
    await dialog.locator(".live-view-control").waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await runtimeStatus(page).then((task) => task?.status), "running", "a paused run stays active");
    assert.equal(await dialog.getByRole("button", { name: /^(Take over|接手)$/u }).count(), 0, "a paused run is already in the person's hands");

    // Input reaches the page now: type into the overlay's field, then press its Close button.
    const control = dialog.locator(".live-view-control");
    const image = control.locator("img.live-view-frame");
    const point = async (target: { x: number; y: number }) => {
      const box = await image.boundingBox();
      const width = Number(await image.getAttribute("width"));
      const height = Number(await image.getAttribute("height"));
      assert.ok(box && width > 0 && height > 0, "the frame is laid out");
      return { x: box.x + (target.x * box.width) / width, y: box.y + (target.y * box.height) / height };
    };
    const field = await point(INPUT_FIELD);
    await page.mouse.click(field.x, field.y);
    await page.keyboard.type(TYPED_MARKER);
    const close = await point(CLOSE_BUTTON);
    await page.mouse.click(close.x, close.y);
    await waitFor(() => fixturePage.closed().length === 1, 15_000, "the page's overlay to close");
    assert.deepEqual(fixturePage.closed(), [{ length: TYPED_MARKER.length }], "typed text reached the page's field");

    // Hand back: the run re-checks the page from its step and completes.
    await dialog.getByRole("button", { name: /^(Hand back|交還)$/u }).click();
    await waitForRenderer(page, async (taskId: string) => {
      const snapshot = await window.octopusBeak.automation.runtimeSnapshot();
      return snapshot.tasks.find((task) => task.taskId === taskId)?.status === "completed";
    }, TASK_ID, 45_000, "the handed-back run to complete");
    assert.equal(fixturePage.visits() >= 1, true);

    // The renderer's own view of the run's history carries no image or typed text.
    const history = await page.evaluate(() => window.octopusBeak.automation.runHistory());
    const rendered = JSON.stringify(history.filter((entry) => entry.taskId === "run-intervention-fixture"));
    assert.doesNotMatch(rendered, /data:image|base64|\/9j\//u);
    for (const marker of [PAGE_MARKER, TYPED_MARKER, QUERY_MARKER]) assert.equal(rendered.includes(marker), false);

    // Persisted: only intervention metadata. Read the ledger once Electron has exited.
    await launch.quit();
    const runs = await readTaskRuns(userData);
    assert.equal(runs.length, 1);
    const [run] = runs;
    assert.equal(run!.status, "completed");
    const log = run!.interventionLog ?? [];
    const actions = log.map((entry) => entry.action);
    for (const action of ["view-opened", "paused", "handed-back"] as const) {
      assert.ok(actions.includes(action), `the run record logs ${action}; got ${actions.join(",")}`);
    }
    assert.ok(actions.indexOf("paused") < actions.indexOf("handed-back"));
    for (const entry of log) {
      assert.deepEqual(Object.keys(entry).sort(), ["action", "at"], "an intervention entry is an action and a time");
    }
    const record = JSON.stringify(run);
    assert.doesNotMatch(record, /data:image|base64|\/9j\//u);
    for (const marker of [PAGE_MARKER, TYPED_MARKER, QUERY_MARKER]) assert.equal(record.includes(marker), false);
    assertNothingVisualOrTypedOnDisk(userData);
  } finally {
    await launch.cleanup();
    await fixturePage.stop();
  }
});

test("isolated Electron/CDP scheduled-style run does not pause and records the step and page kind", async (t) => {
  const fixturePage = await startFixturePage();
  const launch = await launchElectron(t, fixturePage, { OCTOPUSBEAK_CDP_INTERVENTION_SCHEDULED: "1" });
  if (!launch) { await fixturePage.stop(); return; }
  const { page, userData } = launch;
  try {
    await taskRow(page).waitFor({ state: "visible", timeout: 15_000 });
    // The wait expires and a scheduled run fails at once instead of waiting for a person (ADR 0082).
    await waitForRenderer(page, async (taskId: string) => {
      const target = window as unknown as { __needsYou?: boolean };
      const text = document.querySelector(`#${taskId}-task-row`)?.textContent ?? "";
      target.__needsYou = Boolean(target.__needsYou) || /Needs you|需要你處理/u.test(text);
      const snapshot = await window.octopusBeak.automation.runtimeSnapshot();
      return snapshot.tasks.find((candidate) => candidate.taskId === taskId)?.status === "failed";
    }, TASK_ID, 60_000, "the scheduled run to fail");
    const sawNeedsYou = await page.evaluate(() => Boolean((window as unknown as { __needsYou?: boolean }).__needsYou));
    assert.equal(sawNeedsYou, false, "a scheduled run never shows needs you");
    assert.equal(await taskRow(page).locator(".live-view-action").count(), 0, "a scheduled run offers no live view");

    await launch.quit();
    const runs = await readTaskRuns(userData);
    assert.equal(runs.length, 1);
    const [run] = runs;
    assert.equal(run!.status, "failed");
    assert.deepEqual(
      (run!.interventionLog ?? []).filter((entry) => entry.action === "paused" || entry.action === "take-over"),
      [],
      "a scheduled run never pauses",
    );
    // The failure names the step and the page: host and path, never the query.
    const record = JSON.stringify(run);
    assert.match(record, /127\.0\.0\.1/u);
    assert.match(record, /\/bank\/overview/u);
    assert.equal(record.includes(QUERY_MARKER), false, "the page's query never reaches the record");
    assert.equal(record.includes(PAGE_MARKER), false);
    assert.deepEqual(fixturePage.closed(), []);
    assertNothingVisualOrTypedOnDisk(userData);
  } finally {
    await launch.cleanup();
    await fixturePage.stop();
  }
});
