import type {
  WorkflowProgressActivity,
  WorkflowProgressStatementType,
  WorkflowStage,
} from "./workflow-executor.ts";

/** ADR 0059: readers take an event's meaning from its outcome and signal, never its code. */
export const RUN_EVENT_OUTCOMES = ["started", "advanced", "completed", "failed"] as const;
export type RunEventOutcome = typeof RUN_EVENT_OUTCOMES[number];

export const RUN_EVENT_SIGNALS = {
  "verification-solver-exhausted": { stage: "authentication", outcome: "failed" },
  "solver-route-unavailable": { stage: "authentication", outcome: "failed" },
  "solver-challenge-unsupported": { stage: "authentication", outcome: "failed" },
  "login-dialog-interrupted": { stage: "authentication", outcome: "failed" },
  "human-assistance-failed": { stage: "authentication", outcome: "failed" },
  // Run intervention (ADR 0147). The host records these on the run, never in a
  // Workflow execution's log, so none of them classifies a failure. The safe
  // points are the Source sign-in step's waits, so they report its stage.
  "run-intervention-requested": { stage: "authentication", outcome: "advanced" },
  "run-intervention-paused": { stage: "authentication", outcome: "advanced" },
  "run-intervention-handed-back": { stage: "authentication", outcome: "advanced" },
  "run-intervention-given-up": { stage: "authentication", outcome: "advanced" },
  "run-intervention-timed-out": { stage: "authentication", outcome: "failed" },
} as const satisfies Record<string, Readonly<{ stage: WorkflowStage; outcome: RunEventOutcome }>>;
export type RunEventSignal = keyof typeof RUN_EVENT_SIGNALS;

/**
 * The page a run stopped on (ADR 0147): a step's wait for an expected page
 * state timed out, or the page at a URL. Only the URL's host and path are
 * kept; its query, fragment, path parameters and long digit runs never are.
 */
export type RunStopPage =
  | Readonly<{ kind: "step-wait-timeout"; host?: string; path?: string }>
  | Readonly<{ kind: "url"; host: string; path: string }>;

/** Where a failed run stopped: the step it was in and the kind of page it was on. No text, image or input. */
export type RunStop = Readonly<{
  /** The code of the run's last event before it failed. */
  step: string;
  page?: RunStopPage;
}>;

type RunEventDetail = Readonly<{
  runId: string;
  occurredAt: string;
  completed?: number;
  total?: number;
  activity?: WorkflowProgressActivity;
  statementType?: WorkflowProgressStatementType;
  retrying?: boolean;
  /** Only on a failed event. */
  stoppedAt?: RunStop;
}>;

type PlainRunEvent = RunEventDetail & Readonly<{
  stage: WorkflowStage;
  outcome: RunEventOutcome;
  code: string;
  signal?: undefined;
}>;

type SignalRunEvent = {
  [S in RunEventSignal]: RunEventDetail & Readonly<{
    stage: typeof RUN_EVENT_SIGNALS[S]["stage"];
    outcome: typeof RUN_EVENT_SIGNALS[S]["outcome"];
    code: S;
    signal: S;
  }>;
}[RunEventSignal];

export type WorkflowRunEvent = PlainRunEvent | SignalRunEvent;

const OUTCOMES: ReadonlySet<string> = new Set(RUN_EVENT_OUTCOMES);

export function isRunEventSignal(value: unknown): value is RunEventSignal {
  return typeof value === "string" && Object.hasOwn(RUN_EVENT_SIGNALS, value);
}

export function signalRunEvent<S extends RunEventSignal>(
  signal: S,
  detail: Pick<RunEventDetail, "runId" | "occurredAt">,
): Extract<SignalRunEvent, { signal: S }> {
  const { stage, outcome } = RUN_EVENT_SIGNALS[signal];
  return { ...detail, stage, outcome, code: signal, signal } as Extract<SignalRunEvent, { signal: S }>;
}

const STEP = /^[a-z][a-z0-9-]{0,63}$/u;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*$/u;
const PATH = /^\/[A-Za-z0-9._~%!$&'()*+,=:@/-]{0,199}$/u;
const MAX_PATH = 200;
/** Six or more digits can be an account or card number. */
const LONG_DIGITS = /\d{6,}/gu;

/** The host and path of a web page's URL, or null for any other page. */
export function runStopPageLocation(url: string): Readonly<{ host: string; path: string }> | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.toLowerCase();
  if (!HOST.test(host)) return null;
  const path = parsed.pathname
    .split("/")
    .map((segment) => segment.split(";")[0]!.replace(LONG_DIGITS, "*"))
    .join("/")
    .replace(/[^A-Za-z0-9._~%!$&'()*+,=:@/-]/gu, "")
    .slice(0, MAX_PATH);
  return { host, path: path.startsWith("/") ? path : "/" };
}

/** The run stop for a failure in `step`, or undefined when the step is not a safe code. */
export function runStopFor(input: Readonly<{ step: string; timedOut: boolean; url: string | null }>): RunStop | undefined {
  if (!STEP.test(input.step)) return undefined;
  const location = input.url === null ? null : runStopPageLocation(input.url);
  if (input.timedOut) return { step: input.step, page: { kind: "step-wait-timeout", ...location } };
  return location ? { step: input.step, page: { kind: "url", ...location } } : { step: input.step };
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isLocationPart(value: unknown, pattern: RegExp): boolean {
  return typeof value === "string" && pattern.test(value) && !/\d{6,}/u.test(value);
}

/** Boundary check: a run stop of the fixed shape, whose page keeps only a host and a path. */
export function isValidRunStop(value: unknown): value is RunStop {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stop = value as Record<string, unknown>;
  if (!hasOnlyKeys(stop, ["step", "page"]) || typeof stop.step !== "string" || !STEP.test(stop.step)) return false;
  if (stop.page === undefined) return true;
  if (!stop.page || typeof stop.page !== "object" || Array.isArray(stop.page)) return false;
  const page = stop.page as Record<string, unknown>;
  if (!hasOnlyKeys(page, ["kind", "host", "path"])) return false;
  if (page.kind === "url") return isLocationPart(page.host, HOST) && isLocationPart(page.path, PATH);
  if (page.kind !== "step-wait-timeout") return false;
  if (page.host === undefined && page.path === undefined) return true;
  return isLocationPart(page.host, HOST) && isLocationPart(page.path, PATH);
}

/** Boundary check for the closed outcome and a signal that agrees with its stage, outcome and code. */
export function hasValidRunEventMeaning(value: Readonly<Record<string, unknown>>): boolean {
  if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) return false;
  if (value.stoppedAt !== undefined && (value.outcome !== "failed" || !isValidRunStop(value.stoppedAt))) return false;
  if (value.signal === undefined) return !isRunEventSignal(value.code);
  if (!isRunEventSignal(value.signal)) return false;
  const fixed = RUN_EVENT_SIGNALS[value.signal];
  return value.code === value.signal && value.stage === fixed.stage && value.outcome === fixed.outcome;
}

// A cancellation is not a failure: the run status reports it (ADR 0059).
const LEGACY_FAILED = /(?:failed|rejected|malformed|exhausted|unavailable|unsupported|interrupted|error)$/u;
const LEGACY_COMPLETED = /(?:completed|complete|collected|no-data|validated|ready|persisted|admitted)$/u;

export function legacyRunEventOutcome(code: string): RunEventOutcome {
  if (LEGACY_FAILED.test(code)) return "failed";
  if (LEGACY_COMPLETED.test(code)) return "completed";
  if (code.endsWith("started")) return "started";
  return "advanced";
}

/**
 * Give an event stored before ADR 0059 its outcome and signal. Run events are
 * kept 30 days, so this upgrade and the legacy patterns can be deleted after
 * 2026-11-23.
 */
export function upgradeStoredRunEvent(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const event = value as Record<string, unknown>;
  if (event.outcome !== undefined || typeof event.code !== "string") return value;
  if (isRunEventSignal(event.code) && event.stage === RUN_EVENT_SIGNALS[event.code].stage) {
    return { ...event, outcome: RUN_EVENT_SIGNALS[event.code].outcome, signal: event.code };
  }
  return { ...event, outcome: legacyRunEventOutcome(event.code) };
}
