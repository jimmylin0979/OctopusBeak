import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { visibleText, withRenderer } from "./dialog-render-check-support.ts";

const DIALOG = "/src/lib/automation/RunLiveViewDialog.svelte";
const source = readFileSync(new URL("./RunLiveViewDialog.svelte", import.meta.url), "utf8");
const port = {
  openLiveView: () => Promise.reject(new Error("a server render never opens a view")),
  closeLiveView: () => Promise.resolve(),
  onLiveViewFrame: () => () => {},
  onLiveViewEnded: () => () => {},
  takeOverRun: () => Promise.reject(new Error("a server render never takes over")),
  handBackRun: () => Promise.resolve(false),
  giveUpRun: () => Promise.resolve(false),
  interventionInput: () => Promise.reject(new Error("a server render sends no input")),
};
const props = { port, taskId: "sinopac-statements", runId: "run-1", taskLabel: "SinoPac", step: "Signing in", onClose: () => {} };
const frame = { viewId: "view-1", runId: "run-1", data: "AAAA", width: 1280, height: 800 };

test("the live view names its source and the current step, and says it is read-only", async () => {
  await withRenderer(async (render) => {
    const opening = await render(DIALOG, props);
    assert.match(opening, /role="dialog"[^>]*aria-labelledby="run-live-view-title"/);
    const text = visibleText(opening);
    assert.match(text, /Live view · SinoPac/);
    assert.match(text, /Current step: Signing in/);
    assert.match(text, /View only\. Nothing you do here reaches the page\./);
    assert.match(text, /Connecting to the run's page/);
    assert.doesNotMatch(opening, /<img/, "no frame before the first one arrives");
  });
});

test("the live view shows the latest frame from memory as a plain image", async () => {
  await withRenderer(async (render) => {
    const live = await render(DIALOG, { ...props, view: { kind: "live", viewId: "view-1", frame } });
    assert.match(live, /<img[^>]*src="data:image\/jpeg;base64,AAAA"/);
    assert.match(live, /<img[^>]*draggable="false"/);
    assert.doesNotMatch(live, /<img[^>]*tabindex/);
    assert.doesNotMatch(visibleText(live), /Connecting/);
  });
});

test("an ended or failed view says why instead of showing a dead page", async () => {
  await withRenderer(async (render) => {
    const closed = await render(DIALOG, { ...props, view: { kind: "ended", reason: "page-closed" } });
    assert.doesNotMatch(closed, /<img/);
    assert.match(visibleText(closed), /The run moved to a new page\. Open View again to keep watching\./);
    const failed = await render(DIALOG, { ...props, view: { kind: "failed" } });
    assert.match(visibleText(failed), /The live view is not available for this run right now\./);
    const replaced = await render(DIALOG, { ...props, view: { kind: "ended", reason: "replaced" } });
    assert.match(visibleText(replaced), /Another live view opened/);
  });
});

const live = { kind: "live", viewId: "view-1", frame } as const;

test("a watched run offers Take over; while waiting for the current step it says so and takes no input", async () => {
  await withRenderer(async (render) => {
    const watching = await render(DIALOG, { ...props, view: live, intervention: null });
    assert.match(visibleText(watching), /View only\. Nothing you do here reaches the page\./);
    assert.match(watching, /<button[^>]*>\s*Take over\s*<\/button>/u);
    assert.doesNotMatch(visibleText(watching), /Hand back|Give up/u);
    assert.doesNotMatch(watching, /live-view-control/u, "no input surface while watching");

    const waiting = await render(DIALOG, { ...props, view: live, intervention: "requested" });
    assert.match(visibleText(waiting), /Waiting for the current step to finish before you can take over/u);
    assert.match(waiting, /<button[^>]*disabled[^>]*>\s*Take over\s*<\/button>/u);
    assert.doesNotMatch(waiting, /live-view-control/u, "no input before the run has paused");
  });
});

test("Take over is unavailable while the run is verifying, though the person can still watch", async () => {
  await withRenderer(async (render) => {
    const verifying = await render(DIALOG, { ...props, view: live, intervention: null, verifying: true });
    assert.match(verifying, /<img/);
    assert.match(verifying, /<button[^>]*disabled[^>]*>\s*Take over\s*<\/button>/u);
    assert.match(visibleText(verifying), /Take over is unavailable while the run is verifying\./u);
  });
});

test("a paused run gives the person the page with Hand back and Give up", async () => {
  await withRenderer(async (render) => {
    const controlling = await render(DIALOG, { ...props, view: live, intervention: "paused" });
    const text = visibleText(controlling);
    assert.match(text, /The run is paused\. You control the page; press Hand back when it is fixed\./u);
    assert.doesNotMatch(text, /View only/u);
    assert.match(controlling, /<button class="live-view-control[^"]*" type="button" aria-label="The page SinoPac is paused on\./u, "the page takes the person's pointer and keys");
    assert.match(controlling, /<button[^>]*>\s*Hand back\s*<\/button>/u);
    assert.match(controlling, /<button[^>]*>\s*Give up\s*<\/button>/u);
    assert.doesNotMatch(controlling, /<button[^>]*>\s*Take over\s*<\/button>/u);
  });
});

/** The markup between the controlling branch's opening and the next branch. */
const controllingBranch = source.slice(source.indexOf("{#if controlling}"), source.indexOf("{:else}", source.indexOf("{#if controlling}")));

test("pointer and key input is wired only in the controlling state and goes only through the intervention input call", () => {
  assert.ok(controllingBranch.length > 0, "the dialog has a controlling branch");
  const elsewhere = source.replace(controllingBranch, "");
  assert.doesNotMatch(elsewhere, /on(?:pointer|mouse|key|wheel|touch)[a-z]*=/iu, "no input handler outside the controlling state");
  assert.match(controllingBranch, /onpointerdown=/u);
  assert.match(controllingBranch, /onkeydown=/u);
  assert.equal(source.match(/port\.interventionInput\(/gu)?.length, 1, "one call sends input");
  assert.match(source, /function send\([\s\S]*?if \(!controlling[\s\S]*?port\.interventionInput\(/u, "input is sent only while controlling");
});

test("the dialog keeps the frame inert and drops frames of other views", () => {
  assert.match(source, /\.live-view-frame\s*\{[^}]*pointer-events: none/u);
  assert.doesNotMatch(
    source,
    /port\.(?!openLiveView|closeLiveView|onLiveViewFrame|onLiveViewEnded|takeOverRun|handBackRun|giveUpRun|interventionInput)\w+/u,
    "the dialog uses only the view's own calls",
  );
  assert.match(source, /onDestroy\([\s\S]*?port\.closeLiveView\(/u, "closing the dialog stops the screencast");
  assert.match(source, /frame\.viewId !== view\.viewId|frame\.viewId === viewId/u, "a frame from another view is dropped");
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/u, "frames are never kept beyond the open dialog");
});
