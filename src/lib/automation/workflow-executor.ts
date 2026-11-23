import type { WorkflowRunResult } from "./workflow-run-result.ts";
import type { Page } from "playwright";
import type {
  HumanAssistanceContractInput,
  HumanAssistanceCompletionStatus,
} from "./human-assistance.ts";
import type {
  PGliteWorkflowRunItem,
  PGliteWorkflowRunResult,
} from "../../ledger/pglite/workflow-run.ts";
import type { PGliteWorkflowAdmissionReason } from "../../ledger/pglite/workflow-client.ts";
import type { SourceTextPort } from "./source-text.ts";
import type { TypedWorkflowErrorCode } from "./workflow-failures.ts";
import type { PGliteMaicoinPersistencePort } from "../../ledger/pglite/maicoin-operational.ts";
import type { ExchangeRatePersistencePort } from "../../ledger/exchange-rates.ts";
import type { OverviewPageDto } from "../overview/types.ts";
import type { AttachedPreviewSource } from "../preview-sources/attached-products.ts";
import type { WorkflowPreviewWritePort } from "../preview-sources/workflow.ts";
import type { TdccAdmittedFundAccount } from "../../ledger/canonical/tdcc-investment-admission.ts";
import type { AccountIdentityContinuity, AccountIdentityContinuityRequest } from "../../ledger/pglite/account-identity-continuity.ts";
import type { TdccConnection, TdccSessionPort } from "../../workflows/tdcc-session.ts";
import {
  boundProductCollection,
  COLLECTION_PRODUCT_TYPE_IDS,
  interruptedProductCollectionFromOutput,
  type CollectionPeriods,
  type CollectionProductTypeId,
  type ProductCollection,
} from "./product-collection.ts";
import { recordedFinancialCommitPort, type CommitAttemptRecorder } from "./commit-attempt.ts";
import { FailureCodeError, INTERVENTION_TIMED_OUT } from "./workflow-failures.ts";
import type { InterventionPoint, RunInterventionAnswer } from "./run-intervention.ts";
import { reportedVerificationPort, type WorkflowVerificationPort } from "./verification-stage.ts";
import {
  runStopFor,
  signalRunEvent,
  type RunEventOutcome,
  type RunEventSignal,
  type WorkflowRunEvent,
} from "./run-event.ts";

export type WorkflowStage =
  | "preparation"
  | "authentication"
  | "collection"
  | "decoding"
  | "validation"
  | "commit"
  | "finalization";

/** ADR 0056: only the commit port reports the commit stage. */
export type WorkflowContextStage = Exclude<WorkflowStage, "commit">;

export type WorkflowProgressActivity = "query" | "download";
export const WORKFLOW_PROGRESS_STATEMENT_TYPE_IDS = [
  ...COLLECTION_PRODUCT_TYPE_IDS,
  "foreign",
  "investment",
] as const;
export type WorkflowProgressStatementType = typeof WORKFLOW_PROGRESS_STATEMENT_TYPE_IDS[number];
export type WorkflowProgressMetadata = Readonly<{
  activity?: WorkflowProgressActivity;
  statementType?: WorkflowProgressStatementType;
}>;
export type WorkflowEventCounts = Readonly<{
  completed?: number;
  total?: number;
} & WorkflowProgressMetadata>;

/** One product's non-fatal failure, with its error, for the opt-in diagnostics journal. */
export type WorkflowProductFailure = Readonly<{
  stage: WorkflowStage;
  statementType: WorkflowProgressStatementType;
  errorCode: TypedWorkflowErrorCode;
  error: unknown;
  /** The admission rule that rejected a commit item. */
  reason?: PGliteWorkflowAdmissionReason;
}>;

export interface WorkflowEventPort {
  append(event: WorkflowRunEvent): Promise<void>;
}

export interface WorkflowBrowserPort {
  withPage<T>(run: (page: Page) => Promise<T>): Promise<T>;
}

export interface WorkflowHumanAssistancePort {
  request(
    contract: HumanAssistanceContractInput,
    signal: AbortSignal,
  ): Promise<Exclude<HumanAssistanceCompletionStatus, "pending">>;
}

/**
 * How the App answers a workflow's intervention points (ADR 0147): the
 * intervention host call. At a `safe-point` the run pauses only when the
 * person pressed Take over; at a `deadline` it pauses on its own, when the
 * run may.
 */
export interface WorkflowInterventionHostPort {
  consult(signal: AbortSignal, at: InterventionPoint): Promise<RunInterventionAnswer>;
}

/**
 * A workflow's Run intervention points (ADR 0147). Each resolves `none` when
 * the run does not pause there, or `handed-back` after the person paused it
 * there and handed it back, so the step re-checks its page. Each throws when
 * the intervention ended the run: a cancel on Give up, the timed-out
 * User-action Failure after 5 minutes.
 */
export interface WorkflowInterventionPort {
  /**
   * Pauses only when a Take over is waiting. A wait may ask at every poll:
   * the run consults the host about once a second (SAFE_POINT_CONSULT_MS).
   */
  safePoint(): Promise<"none" | "handed-back">;
  /**
   * A step's wait for an expected page state timed out. A manual run pauses
   * here as if Take over had been pressed; `none` (a scheduled run, a Verification
   * Stage, the pause cap) means the step fails as it would without a person.
   */
  deadlineExpired(): Promise<"none" | "handed-back">;
}

/** The App injects this port; its adapter uses the existing canonical worker. */
export interface WorkflowFinancialCommitPort {
  execute(
    items: readonly PGliteWorkflowRunItem[],
    options?: Readonly<{ provider?: string; product?: string; signal?: AbortSignal }>,
  ): Promise<PGliteWorkflowRunResult<unknown>>;
}

/** TDCC's host-owned session and the fund accounts the store has admitted for its connection. */
export type WorkflowTdccPort = Readonly<{
  session: TdccSessionPort;
  admittedFundAccounts(connection: TdccConnection): Promise<readonly TdccAdmittedFundAccount[]>;
}>;

/** What the exchange-rate sync reads and writes: the rates it keeps and the history that says which it needs. */
export type WorkflowExchangeRatePort = Readonly<{
  persistence: ExchangeRatePersistencePort;
  overviewCurrent(): Promise<Pick<OverviewPageDto, "dailyHistory">>;
}>;

export type WorkflowAccountIdentityPort = Readonly<{
  continuity(request: AccountIdentityContinuityRequest): Promise<AccountIdentityContinuity>;
}>;

export type WorkflowContext = Readonly<{
  runId: string;
  signal: AbortSignal;
  now(): string;
  browser: WorkflowBrowserPort;
  text: SourceTextPort;
  verification: WorkflowVerificationPort;
  /** Absent outside the App, where no person can take over. */
  intervention?: WorkflowInterventionPort;
  financialCommit?: WorkflowFinancialCommitPort;
  maicoinPersistence?: PGliteMaicoinPersistencePort;
  tdcc?: WorkflowTdccPort;
  exchangeRates?: WorkflowExchangeRatePort;
  accountIdentity?: WorkflowAccountIdentityPort;
  previewWrite?: WorkflowPreviewWritePort;
  /** The Product collection run bound to this run's Verified source. */
  products?: ProductCollection;
  event(
    stage: WorkflowContextStage,
    outcome: RunEventOutcome,
    code: string,
    counts?: WorkflowEventCounts,
  ): Promise<void>;
  /** A signal fixes its own stage and outcome (ADR 0059). */
  signalEvent(signal: RunEventSignal): Promise<void>;
  productFailure?(failure: WorkflowProductFailure): Promise<void>;
}>;

/** A workflow returns its run result, or nothing when it records no run counts. */
export type WorkflowOutput = WorkflowRunResult | void;

export type WorkflowDefinition<Input = unknown, Output extends WorkflowOutput = WorkflowOutput> = Readonly<{
  id: string;
  requiresFinancialCommit: boolean;
  requiresMaicoinPersistence?: boolean;
  requiresTdcc?: boolean;
  requiresExchangeRates?: boolean;
  requiresAccountIdentity?: boolean;
  requiresPreviewWrite?: boolean;
  /** ADR 0051: the preview products this verified workflow may write beside its canonical commit. */
  attachedPreviewProducts?: AttachedPreviewSource;
  requiresProductCollection?: boolean;
  /** The Verified source facts the Product collection run is bound to; present when it is required. */
  productCollection?: Readonly<{
    provider: string;
    productIds: readonly CollectionProductTypeId[];
    /** ADR 0077: each product's declared collection period. */
    collectionPeriods?: CollectionPeriods;
  }>;
  run(context: WorkflowContext, input: Input): Promise<Output>;
}>;

/** Whether the definition's context carries `previewWrite` when the port is available. */
export function workflowUsesPreviewWrite(definition: Pick<WorkflowDefinition, "requiresPreviewWrite" | "attachedPreviewProducts">): boolean {
  return definition.requiresPreviewWrite === true || definition.attachedPreviewProducts !== undefined;
}

export type WorkflowExecutorPorts = Readonly<{
  browser: WorkflowBrowserPort;
  text: SourceTextPort;
  humanAssistance: WorkflowHumanAssistancePort;
  /** Without it, every safe point runs on. */
  intervention?: WorkflowInterventionHostPort;
  financialCommit?: WorkflowFinancialCommitPort;
  maicoinPersistence?: PGliteMaicoinPersistencePort;
  tdcc?: WorkflowTdccPort;
  exchangeRates?: WorkflowExchangeRatePort;
  accountIdentity?: WorkflowAccountIdentityPort;
  previewWrite?: WorkflowPreviewWritePort;
  /** Required with financialCommit: each request is recorded before it starts. */
  commitAttempts?: CommitAttemptRecorder;
  events: WorkflowEventPort;
  now(): string;
  onEventFailure?(code: "event-persistence-failed"): void;
  productFailure?(failure: WorkflowProductFailure): Promise<void>;
}>;

/** Each capability a definition can require: the flag that requires it and the port that serves it. */
const WORKFLOW_CAPABILITIES = {
  financialCommit: { flag: "requiresFinancialCommit", label: "Canonical Financial Commit" },
  maicoinPersistence: { flag: "requiresMaicoinPersistence", label: "MaiCoin operational persistence" },
  tdcc: { flag: "requiresTdcc", label: "TDCC session" },
  exchangeRates: { flag: "requiresExchangeRates", label: "Exchange rates" },
  accountIdentity: { flag: "requiresAccountIdentity", label: "Account identity" },
  previewWrite: { flag: "requiresPreviewWrite", label: "Preview write" },
} as const satisfies Record<string, Readonly<{ flag: keyof WorkflowDefinition; label: string }>>;

export type WorkflowCapability = keyof typeof WORKFLOW_CAPABILITIES;
type WorkflowCapabilityFlag<C extends WorkflowCapability> = (typeof WORKFLOW_CAPABILITIES)[C]["flag"];

/**
 * A context member a definition can require: a capability port, or the
 * Product collection run, which the executor builds from the definition
 * instead of serving from a port.
 */
export type WorkflowContextCapability = WorkflowCapability | "products";

/** The capabilities whose flag a definition sets to a literal `true`. */
export type RequiredCapabilities<Flags> =
  | {
    [C in WorkflowCapability]: Flags extends Readonly<Record<WorkflowCapabilityFlag<C>, true>> ? C : never;
  }[WorkflowCapability]
  | (Flags extends Readonly<{ requiresProductCollection: true }> ? "products" : never);

/** The ports a definition may carry without requiring: preview writes for its attached products. */
export type OptionalCapabilities<Flags> = Flags extends Readonly<{ attachedPreviewProducts: object }> ? "previewWrite" : never;

/**
 * A context whose required members `C` are present, because the executor checks
 * them before every run, and whose other members are absent, except the optional
 * ports `O` the definition may carry.
 */
export type WorkflowContextWith<C extends WorkflowContextCapability, O extends WorkflowCapability = never> =
  Omit<WorkflowContext, WorkflowContextCapability>
  & Readonly<{ [K in C]-?: NonNullable<WorkflowContext[K]> }>
  & Readonly<{ [K in O]?: WorkflowContext[K] }>
  & Readonly<{ [K in Exclude<WorkflowContextCapability, C | O>]?: never }>;

/** A run that may use the ports its definition requires, and only those. */
export type WorkflowRun<
  C extends WorkflowContextCapability,
  Input = unknown,
  Output extends WorkflowOutput = WorkflowOutput,
  O extends WorkflowCapability = never,
> = (
  context: WorkflowContextWith<C, O>,
  input: Input,
) => Promise<Output>;

/**
 * Declares a definition whose run is typed by its capability flags, so a run
 * that uses a port its definition does not require fails to compile.
 */
export function defineWorkflow<
  const Flags extends Omit<WorkflowDefinition, "run">,
  Input = unknown,
  Output extends WorkflowOutput = WorkflowOutput,
>(
  flags: Flags,
  run: WorkflowRun<RequiredCapabilities<Flags>, Input, Output, OptionalCapabilities<Flags>>,
): WorkflowDefinition<Input, Output> {
  return { ...flags, run } as WorkflowDefinition<Input, Output>;
}
export type WorkflowCapabilityPorts = Pick<WorkflowExecutorPorts, WorkflowCapability>;
type WorkflowCapabilityFlags = Pick<WorkflowDefinition, (typeof WORKFLOW_CAPABILITIES)[WorkflowCapability]["flag"]>;

/** The capability ports a definition cannot run without. */
export function requiredWorkflowCapabilities(
  definition: WorkflowCapabilityFlags,
): readonly WorkflowCapability[] {
  return (Object.keys(WORKFLOW_CAPABILITIES) as WorkflowCapability[])
    .filter((capability) => definition[WORKFLOW_CAPABILITIES[capability].flag] === true);
}

/** The definition's required capability ports, each from the first source that serves it. */
export function requiredCapabilityPorts(
  definition: WorkflowCapabilityFlags,
  ...sources: readonly (Partial<WorkflowCapabilityPorts> | undefined)[]
): Partial<WorkflowCapabilityPorts> {
  const ports: Partial<Record<WorkflowCapability, unknown>> = {};
  for (const capability of requiredWorkflowCapabilities(definition)) {
    const port = sources.find((source) => source?.[capability])?.[capability];
    if (port) ports[capability] = port;
  }
  return ports as Partial<WorkflowCapabilityPorts>;
}

const SAFE_CODE = /^[a-z][a-z0-9-]{0,63}$/u;
const PROGRESS_STATEMENT_TYPES = new Set<string>(WORKFLOW_PROGRESS_STATEMENT_TYPE_IDS);

/** The executor's own event writer, which unlike WorkflowContext.event may report the commit stage. */
type StageEvent = (
  stage: WorkflowStage,
  outcome: RunEventOutcome,
  code: string,
  counts?: WorkflowEventCounts,
) => Promise<void>;

/** Preview rows are written outside canonical admission, but the writer still owns its commit stage. */
function reportedPreviewWritePort(
  port: WorkflowPreviewWritePort,
  event: StageEvent,
): WorkflowPreviewWritePort {
  return {
    async write(input) {
      const receipt = await port.write(input);
      if (receipt.accounts > 0) {
        await event("commit", "completed", `${input.product.replaceAll("_", "-")}-preview-write-completed`, {
          completed: receipt.accounts,
          total: receipt.accounts,
          statementType: input.product,
        });
      }
      return receipt;
    },
  };
}

const STEP_WAIT_TIMEOUTS = new Set(["TimeoutError", "FrameScopeTimeoutError"]);
const MAX_CAUSES = 4;

/** Whether a wait for an expected page state timed out, even when the workflow wrapped the timeout. */
function isStepWaitTimeout(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSES && current instanceof Error; depth += 1) {
    if (STEP_WAIT_TIMEOUTS.has(current.name)) return true;
    current = current.cause;
  }
  return false;
}

/**
 * The run's browser port, remembering the URL of the page a failure left
 * while the workflow still held it. Only the URL is read, never the page's
 * text or a picture, and the page is never visited again to read it.
 */
function stopRecordingBrowserPort(browser: WorkflowBrowserPort, signal: AbortSignal) {
  let stoppedUrl: string | null = null;
  const port: WorkflowBrowserPort = {
    withPage: (run) => browser.withPage(async (page) => {
      stoppedUrl = null;
      try {
        return await run(page);
      } catch (error) {
        // A stopped run names no page.
        if (!signal.aborted) {
          try { stoppedUrl = page.url(); } catch { stoppedUrl = null; }
        }
        throw error;
      }
    }),
  };
  return { port, stoppedUrl: () => stoppedUrl };
}

/**
 * A safe point that answered `none` is not asked again for this long, across
 * every wait of the run (ADR 0147). It bounds how soon a Take over is heard,
 * and keeps the run within the host's consult rate however many waits poll.
 */
export const SAFE_POINT_CONSULT_MS = 1_000;

/** The workflow's intervention points over the host's answer; an answer that ends the run throws. */
function interventionPort(host: WorkflowInterventionHostPort, signal: AbortSignal): WorkflowInterventionPort {
  let ranOnAt = Number.NEGATIVE_INFINITY;
  const consult = async (at: InterventionPoint): Promise<"none" | "handed-back"> => {
    signal.throwIfAborted();
    if (at === "safe-point" && Date.now() - ranOnAt < SAFE_POINT_CONSULT_MS) return "none";
    const answer = await host.consult(signal, at);
    signal.throwIfAborted();
    if (at === "safe-point" && answer === "none") ranOnAt = Date.now();
    if (answer === "timed-out") {
      throw new FailureCodeError(INTERVENTION_TIMED_OUT, "The run paused for the person, who did not come back in time.");
    }
    // Give up stops the run, so its answer normally never arrives; it still ends the run as a cancel.
    if (answer === "given-up") throw new FailureCodeError("cancelled", "The person gave up the run.");
    return answer;
  };
  return {
    safePoint: () => consult("safe-point"),
    deadlineExpired: () => consult("deadline"),
  };
}

/** Common composition point for provider definitions and App-owned ports. */
export function createWorkflowExecutor(
  definitions: readonly WorkflowDefinition[],
  ports: WorkflowExecutorPorts,
) {
  const byId = new Map<string, WorkflowDefinition>();
  for (const definition of definitions) {
    if (byId.has(definition.id)) throw new Error(`Duplicate workflow ID: ${definition.id}`);
    byId.set(definition.id, definition);
  }

  return {
    list: () => [...byId.keys()],
    async run(
      id: string,
      runId: string,
      input: unknown,
      signal: AbortSignal,
    ): Promise<unknown> {
      const definition = byId.get(id);
      if (!definition) throw new Error(`Unknown workflow ID: ${id}`);
      const capabilityPorts = requiredCapabilityPorts(definition, ports);
      for (const capability of requiredWorkflowCapabilities(definition)) {
        if (!capabilityPorts[capability]) {
          throw new Error(`${WORKFLOW_CAPABILITIES[capability].label} port is unavailable.`);
        }
      }
      // The step a failure stopped in is the run's last operation (ADR 0147).
      let step = "run-started";
      const browser = stopRecordingBrowserPort(ports.browser, signal);
      const appendEvent = async (runEvent: WorkflowRunEvent): Promise<void> => {
        if (!SAFE_CODE.test(runEvent.code)) throw new Error("Invalid workflow event code.");
        if (runEvent.stage !== "finalization") step = runEvent.code;
        await ports.events.append(runEvent);
      };
      const stageEvent = (
        ...[stage, outcome, code, counts]: Parameters<StageEvent>
      ): WorkflowRunEvent => ({
        runId,
        stage,
        outcome,
        code,
        occurredAt: ports.now(),
        ...(counts?.completed === undefined ? {} : { completed: counts.completed }),
        ...(counts?.total === undefined ? {} : { total: counts.total }),
        ...(counts?.activity === undefined ? {} : { activity: counts.activity }),
        ...(counts?.statementType === undefined ? {} : { statementType: counts.statementType }),
      });
      const report = async (runEvent: () => WorkflowRunEvent): Promise<void> => {
        try {
          await appendEvent(runEvent());
        } catch {
          // Progress persistence must not turn a successful financial commit
          // into a failed run with an ambiguous retry outcome.
          try {
            ports.onEventFailure?.("event-persistence-failed");
          } catch {
            // A diagnostic hook cannot change the workflow outcome either.
          }
        }
      };
      const event: StageEvent = (...args) => report(() => stageEvent(...args));
      const signalEvent = (signal: RunEventSignal) => report(() => signalRunEvent(signal, { runId, occurredAt: ports.now() }));
      const productFailure: WorkflowContext["productFailure"] = async (failure) => {
        try {
          await ports.productFailure?.(failure);
        } catch {
          // A diagnostic sink cannot change the workflow outcome.
        }
      };
      let financialCommit: WorkflowFinancialCommitPort | undefined;
      if (capabilityPorts.financialCommit) {
        if (!ports.commitAttempts) throw new Error("Commit attempt recorder is unavailable.");
        financialCommit = recordedFinancialCommitPort({
          commit: capabilityPorts.financialCommit,
          attempts: ports.commitAttempts,
          event: (outcome, code, counts, product) => event("commit", outcome, code, {
            ...counts,
            ...(product !== null && PROGRESS_STATEMENT_TYPES.has(product)
              ? { statementType: product as WorkflowProgressStatementType }
              : {}),
          }),
        });
      }
      const previewWrite = workflowUsesPreviewWrite(definition) && ports.previewWrite
        ? reportedPreviewWritePort(ports.previewWrite, event)
        : undefined;
      let products: ProductCollection | undefined;
      if (definition.requiresProductCollection) {
        if (!definition.productCollection || !financialCommit) throw new Error("Product collection is unavailable.");
        products = boundProductCollection({
          ...definition.productCollection,
          now: ports.now,
          text: ports.text,
          input,
          ...(definition.attachedPreviewProducts ? { attachedSource: definition.attachedPreviewProducts } : {}),
          signal,
          event,
          productFailure,
          financialCommit,
          ...(previewWrite ? { previewWrite } : {}),
        });
      }
      const context: WorkflowContext = {
        runId,
        signal,
        now: ports.now,
        browser: browser.port,
        text: ports.text,
        verification: reportedVerificationPort({ humanAssistance: ports.humanAssistance, signal, event, signalEvent }),
        ...(ports.intervention ? { intervention: interventionPort(ports.intervention, signal) } : {}),
        ...capabilityPorts,
        ...(financialCommit ? { financialCommit } : {}),
        ...(previewWrite ? { previewWrite } : {}),
        ...(products ? { products } : {}),
        event,
        signalEvent,
        productFailure,
      };
      signal.throwIfAborted();
      // Before any provider action, fail closed if the operational store is unavailable.
      await appendEvent(stageEvent("preparation", "started", "run-started"));
      try {
        const result = await definition.run(context, input);
        const throwIfAbortedWithProductResults = () => {
          if (!signal.aborted) return;
          const interrupted = interruptedProductCollectionFromOutput(result);
          if (interrupted) throw interrupted;
          signal.throwIfAborted();
        };
        throwIfAbortedWithProductResults();
        await event("finalization", "completed", "run-completed");
        throwIfAbortedWithProductResults();
        return result;
      } catch (error) {
        if (signal.aborted) {
          await event("finalization", "advanced", "run-cancelled");
          throw error;
        }
        const stoppedAt = runStopFor({
          step,
          timedOut: isStepWaitTimeout(error),
          url: browser.stoppedUrl(),
        });
        await report(() => ({ ...stageEvent("finalization", "failed", "run-failed"), ...(stoppedAt ? { stoppedAt } : {}) }));
        throw error;
      }
    },
  };
}
