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
export const RUN_INTERVENTION_ACTIONS = [
  "view-opened",
  "view-closed",
  /** The person pressed Take over; the run pauses at its next safe point. */
  "take-over",
  /** The run reached a safe point and the person controls the page. */
  "paused",
  "handed-back",
  "given-up",
  /** Five minutes paused without the person. */
  "timed-out",
] as const;
export type RunInterventionAction = typeof RUN_INTERVENTION_ACTIONS[number];

export type RunInterventionEntry = Readonly<{ action: RunInterventionAction; at: string }>;

/**
 * Where a run's intervention stands: Take over was pressed and the run has not
 * reached a safe point yet; the run has paused but waits for you while another
 * run's intervention is active, keeping its browser; or the run is paused and
 * the person controls the page. A run with none of these has no intervention.
 * Only one run is paused for the person at a time (ADR 0147).
 */
export type RunInterventionState = "requested" | "waiting" | "paused";

/** How a paused intervention ended, as the workflow waiting at its safe point hears it. */
export const RUN_INTERVENTION_RESOLUTIONS = ["handed-back", "given-up", "timed-out"] as const;
export type RunInterventionResolution = typeof RUN_INTERVENTION_RESOLUTIONS[number];

/**
 * Where a workflow consults the host about a Run intervention. A `safe-point`
 * pauses only for a Take over already waiting; a `deadline` is a step's wait
 * for an expected page state timing out, which pauses a manual run on its own.
 */
export const INTERVENTION_POINTS = ["safe-point", "deadline"] as const;
export type InterventionPoint = typeof INTERVENTION_POINTS[number];

/** The host's answer at an intervention point; `none`: the run does not pause, so the workflow runs on. */
export type RunInterventionAnswer = "none" | RunInterventionResolution;

/** Why Take over was refused. */
export type TakeOverRefusal =
  /** A scheduled run never waits for a person. */
  | "not-manual"
  /** A Verification Stage is open; only the solver completes it (ADR 0039). */
  | "verifying"
  /** The run is not running, such as one still preparing, cancelling or finished. */
  | "not-running"
  /** A Take over is already waiting for its safe point, or the run is paused. */
  | "pending"
  /** The run has already paused as often as it may. */
  | "exhausted";

export type TakeOverResult = Readonly<{ ok: true }> | Readonly<{ ok: false; refused: TakeOverRefusal }>;

/**
 * One pointer or key action the renderer sends while the run is paused, in
 * the page's CSS pixels. The host normalizes it again with the viewer input
 * rules; it is never stored or logged.
 */
export type RunInterventionInput =
  | Readonly<{ type: "click"; x: number; y: number }>
  | Readonly<{ type: "drag"; x: number; y: number; toX: number; toY: number }>
  | Readonly<{ type: "type"; text: string }>
  | Readonly<{ type: "press"; key: string }>;

/** A run pauses once, then at most three more times (ADR 0147). */
export const MAX_RUN_INTERVENTION_PAUSES = 4;

/** A paused run ends with a User-action Failure after this long without the person. */
export const RUN_INTERVENTION_TIMEOUT_MS = 5 * 60_000;

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
