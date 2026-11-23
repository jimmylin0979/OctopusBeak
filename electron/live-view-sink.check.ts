import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { liveViewSink, type LiveViewSender } from "./live-view-sink.ts";

function fakeSender() {
  const emitter = new EventEmitter();
  const sent: Array<[string, unknown]> = [];
  const sender = {
    send: (channel: string, payload: unknown) => sent.push([channel, payload]),
    isDestroyed: () => false,
    on: (event: string, listener: (...args: any[]) => void) => emitter.on(event, listener),
    removeListener: (event: string, listener: (...args: any[]) => void) => emitter.removeListener(event, listener),
  } as unknown as LiveViewSender;
  return { sender, emitter, sent };
}

test("the sink tells the window that opened the view and no other", () => {
  const { sender, sent } = fakeSender();
  const sink = liveViewSink(sender);
  sink.ended({ viewId: "v", reason: "closed" });
  assert.deepEqual(sent, [["automation:live-view-ended", { viewId: "v", reason: "closed" }]]);
});

test("a reload of the window or its render process going away ends the view", () => {
  for (const [event, args] of [
    ["did-start-navigation", [{ isMainFrame: true, isSameDocument: false }]],
    ["render-process-gone", [{}, { reason: "crashed" }]],
    ["destroyed", []],
  ] as const) {
    const { sender, emitter } = fakeSender();
    let lost = 0;
    liveViewSink(sender).onGone!(() => { lost += 1; });
    emitter.emit(event, ...args);
    assert.equal(lost, 1, event);
  }
});

test("a navigation inside the page or in a sub frame does not end the view", () => {
  const { sender, emitter } = fakeSender();
  let lost = 0;
  liveViewSink(sender).onGone!(() => { lost += 1; });
  emitter.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  emitter.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
  assert.equal(lost, 0);
});

test("a view that has ended stops listening to the window", () => {
  const { sender, emitter } = fakeSender();
  let lost = 0;
  const stop = liveViewSink(sender).onGone!(() => { lost += 1; });
  stop();
  emitter.emit("render-process-gone", {}, {});
  assert.equal(lost, 0);
  assert.equal(emitter.listenerCount("did-start-navigation"), 0);
});
