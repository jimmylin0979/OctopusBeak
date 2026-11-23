import type { WebContents } from "electron";
import type { RunLiveViewSink } from "../src/lib/automation/server/run-live-view.ts";
import type { OctopusBeakLiveViewChannel } from "./preload.ts";

/** What the sink uses of a window's contents, so a check can stand in for it. */
export type LiveViewSender = Pick<WebContents, "send" | "isDestroyed" | "on" | "removeListener">;

/**
 * A Run live view's frames reach only the window that opened it (ADR 0147). The
 * view is lost when that window reloads or its render process goes away, since
 * the dialog showing it is gone and a paused run would wait for no one.
 */
export function liveViewSink(sender: LiveViewSender): RunLiveViewSink {
  return {
    frame: (frame) => sender.send("automation:live-view-frame" satisfies OctopusBeakLiveViewChannel, frame),
    ended: (end) => sender.send("automation:live-view-ended" satisfies OctopusBeakLiveViewChannel, end),
    gone: () => sender.isDestroyed(),
    onGone(listener) {
      const onNavigation = (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) listener();
      };
      const onLost = () => listener();
      sender.on("did-start-navigation", onNavigation);
      sender.on("render-process-gone", onLost);
      sender.on("destroyed", onLost);
      return () => {
        if (sender.isDestroyed()) return;
        sender.removeListener("did-start-navigation", onNavigation);
        sender.removeListener("render-process-gone", onLost);
        sender.removeListener("destroyed", onLost);
      };
    },
  };
}
