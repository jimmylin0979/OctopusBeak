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

test("the dialog sends no input to the page", () => {
  assert.doesNotMatch(source, /on(?:pointer|mouse|key|wheel|touch)[a-z]*=|onclick=\{[^}]*frame/iu, "the frame takes no pointer or key events");
  assert.match(source, /\.live-view-frame\s*\{[^}]*pointer-events: none/u);
  assert.doesNotMatch(source, /port\.(?!openLiveView|closeLiveView|onLiveViewFrame|onLiveViewEnded)\w+/u, "the dialog uses only the view's own calls");
  assert.match(source, /onDestroy\([\s\S]*?port\.closeLiveView\(/u, "closing the dialog stops the screencast");
  assert.match(source, /frame\.viewId !== view\.viewId|frame\.viewId === viewId/u, "a frame from another view is dropped");
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/u, "frames are never kept beyond the open dialog");
});
