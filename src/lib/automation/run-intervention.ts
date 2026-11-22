/**
 * Who started an Automation Task Run. Only a manual run offers a Run live view
 * or a Run intervention; a scheduled one never waits for a person (ADR 0147).
 */
export type RunTrigger = "manual" | "scheduled";

export function runTrigger(scheduledAtUtc: string | undefined): RunTrigger {
  return scheduledAtUtc === undefined ? "manual" : "scheduled";
}

/** One painted frame of a watched run's page. It lives in memory only and is never stored or logged (ADR 0147). */
export type RunLiveViewFrame = Readonly<{
  viewId: string;
  runId: string;
  /** Base64 JPEG as the screencast gave it. */
  data: string;
  width: number;
  height: number;
}>;

export type RunLiveViewEndReason = "closed" | "replaced" | "run-ended" | "page-closed" | "failed";

export type RunLiveViewEnd = Readonly<{ viewId: string; reason: RunLiveViewEndReason }>;

/**
 * What the person did to a run, as the run's record keeps it. Frames and the
 * person's input are session-memory only (ADR 0147); an entry holds the action
 * and its time and nothing else.
 */
export const RUN_INTERVENTION_ACTIONS = ["view-opened", "view-closed"] as const;
export type RunInterventionAction = typeof RUN_INTERVENTION_ACTIONS[number];

export type RunInterventionEntry = Readonly<{ action: RunInterventionAction; at: string }>;

/** A run keeps this many entries at most, the most recent ones. */
export const MAX_RUN_INTERVENTION_ENTRIES = 64;

const ACTIONS: ReadonlySet<string> = new Set(RUN_INTERVENTION_ACTIONS);

function isCanonicalInstant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Only known actions with canonical times survive, rebuilt field by field so nothing else is carried. */
export function sanitizeRunInterventionLog(value: unknown): RunInterventionEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): RunInterventionEntry[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const { action, at } = candidate as Record<string, unknown>;
    return typeof action === "string" && ACTIONS.has(action) && isCanonicalInstant(at)
      ? [{ action: action as RunInterventionAction, at }]
      : [];
  }).slice(-MAX_RUN_INTERVENTION_ENTRIES);
}
