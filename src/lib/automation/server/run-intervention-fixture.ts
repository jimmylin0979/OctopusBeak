import { workflowRunResult } from "../workflow-run-result.ts";
import type { WorkflowDefinition } from "../workflow-executor.ts";
import { frameScope } from "../../../workflows/frame-scope.ts";
import { expectPageState } from "../../../workflows/page-state-wait.ts";

/**
 * A test-only source for the Electron/CDP check of the Run live view and Run
 * intervention (ADR 0147). It loads one loopback page that shows an overlay
 * over the element the step expects. It exists only when the disposable CDP
 * fixture launch (`OCTOPUSBEAK_CDP_FIXTURE=171`) names the page, and main
 * refuses it in a packaged App. It has no credentials and writes no data.
 */
export const RUN_INTERVENTION_FIXTURE_URL_ENV = "OCTOPUSBEAK_CDP_INTERVENTION_FIXTURE_URL";
export const RUN_INTERVENTION_FIXTURE_TASK_ID = "run-intervention-fixture";
/** The step's expected element; the page's overlay covers it until a person closes the overlay. */
export const RUN_INTERVENTION_FIXTURE_TARGET = "#fixture-target";
export const RUN_INTERVENTION_FIXTURE_OVERLAY = "#fixture-overlay";
/** The step's wait expires this soon, so the check does not wait a minute. */
export const RUN_INTERVENTION_FIXTURE_WAIT_MS = 6_000;
export const RUN_INTERVENTION_FIXTURE_FAILURE = "Timed out waiting for the fixture page.";

export function runInterventionFixtureEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.OCTOPUSBEAK_CDP_FIXTURE === "171"
    && Boolean(environment[RUN_INTERVENTION_FIXTURE_URL_ENV]);
}

/** Accept only an ephemeral loopback page, as the packaged browser fixture does. */
export function runInterventionFixtureStartUrl(environment: NodeJS.ProcessEnv = process.env): string {
  if (!runInterventionFixtureEnabled(environment)) {
    throw new Error("Run intervention fixture is disabled.");
  }
  let url: URL;
  try {
    url = new URL(environment[RUN_INTERVENTION_FIXTURE_URL_ENV]!);
  } catch {
    throw new Error("Run intervention fixture URL is invalid.");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) {
    throw new Error("Run intervention fixture URL must be an ephemeral loopback URL.");
  }
  return url.href;
}

export function runInterventionFixtureDefinition(): WorkflowDefinition {
  return {
    id: RUN_INTERVENTION_FIXTURE_TASK_ID,
    requiresFinancialCommit: false,
    async run(context) {
      await context.browser.withPage(async (page) => {
        const scope = frameScope(page, context.signal);
        await expectPageState(
          scope,
          context.intervention,
          async () => (await page.locator(RUN_INTERVENTION_FIXTURE_OVERLAY).count()) === 0
            && await page.locator(RUN_INTERVENTION_FIXTURE_TARGET).isVisible(),
          RUN_INTERVENTION_FIXTURE_FAILURE,
          { timeoutMs: RUN_INTERVENTION_FIXTURE_WAIT_MS },
        );
      });
      await context.event("collection", "advanced", "fixture-target-visible", { completed: 1, total: 1 });
      return workflowRunResult({ status: "completed", counts: {} });
    },
  };
}
