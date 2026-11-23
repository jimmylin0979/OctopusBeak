import type { WorkflowInterventionPort } from "../lib/automation/workflow-executor.ts";
import { FRAME_SCOPE_TIMEOUT_MS, FrameScopeTimeoutError, type FrameScope } from "./frame-scope.ts";

const POLL_INTERVAL_MS = 250;

export type PageStateWaitOptions = Readonly<{
  /** How long the page may take to reach the state before the wait expires. Default 60 s. */
  timeoutMs?: number;
}>;

/**
 * Wait, during collection after sign-in, for the page to reach a state the
 * step expects, as the Source sign-in step's deadline does (ADR 0147).
 *
 * The probe runs until it returns a value, which the wait returns. Every
 * pass is a Run intervention safe point: a Take over pauses the run here, and
 * after Hand back the page is checked again with a fresh deadline. When the
 * deadline expires, a manual run pauses for the person in the same way. The
 * host answers `none` for a scheduled run, an open Verification Stage or a
 * run past its pause cap, and the wait then fails with `FrameScopeTimeoutError`
 * carrying `failure`, so the run stop records the step and a step-wait
 * timeout. Without a port (outside the App) the wait only times out.
 *
 * The probe must only read the page: after Hand back it runs again, and the
 * person may have changed the page meanwhile. Keep requests and clicks that
 * must happen once outside it.
 */
export async function expectPageState<T>(
  scope: FrameScope,
  intervention: WorkflowInterventionPort | undefined,
  probe: () => Promise<T | null | undefined | false>,
  failure: string,
  { timeoutMs = FRAME_SCOPE_TIMEOUT_MS }: PageStateWaitOptions = {},
): Promise<T> {
  let deadline = Date.now() + timeoutMs;
  for (;;) {
    scope.signal.throwIfAborted();
    const value = await scope.race(probe());
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() >= deadline) {
      if (intervention && (await scope.race(intervention.deadlineExpired())) === "handed-back") {
        deadline = Date.now() + timeoutMs;
        continue;
      }
      throw new FrameScopeTimeoutError(failure);
    }
    // The run's port consults the host at most once a second, however often this asks.
    if (intervention && (await scope.race(intervention.safePoint())) === "handed-back") {
      deadline = Date.now() + timeoutMs;
      continue;
    }
    await scope.pause(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
}
