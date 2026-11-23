import assert from "node:assert/strict";
import test from "node:test";
import { appWorkflowCatalogForEnvironment } from "./app-workflow-registry.ts";
import { automationTasksForEnvironment } from "./tasks.ts";
import {
  RUN_INTERVENTION_FIXTURE_TASK_ID,
  runInterventionFixtureEnabled,
  runInterventionFixtureStartUrl,
} from "./run-intervention-fixture.ts";

const environment = {
  OCTOPUSBEAK_CDP_FIXTURE: "171",
  OCTOPUSBEAK_CDP_INTERVENTION_FIXTURE_URL: "http://127.0.0.1:43121/bank?token=abc",
};

test("the Run intervention fixture needs the disposable CDP fixture and a loopback page", () => {
  assert.equal(runInterventionFixtureEnabled({}), false);
  assert.equal(runInterventionFixtureEnabled({ OCTOPUSBEAK_CDP_INTERVENTION_FIXTURE_URL: environment.OCTOPUSBEAK_CDP_INTERVENTION_FIXTURE_URL }), false);
  assert.equal(runInterventionFixtureEnabled({ OCTOPUSBEAK_CDP_FIXTURE: "171" }), false);
  assert.equal(runInterventionFixtureEnabled(environment), true);
  assert.equal(runInterventionFixtureStartUrl(environment), environment.OCTOPUSBEAK_CDP_INTERVENTION_FIXTURE_URL);
  assert.throws(() => runInterventionFixtureStartUrl({}), /disabled/u);
  for (const url of ["http://example.com/", "https://127.0.0.1:43121/", "http://user@127.0.0.1:43121/", "http://127.0.0.1/"]) {
    assert.throws(
      () => runInterventionFixtureStartUrl({ ...environment, OCTOPUSBEAK_CDP_INTERVENTION_FIXTURE_URL: url }),
      /loopback/u,
      url,
    );
  }
});

test("the fixture task and workflow exist only in fixture mode and need no credentials", () => {
  assert.equal(automationTasksForEnvironment({}).some((task) => task.id === RUN_INTERVENTION_FIXTURE_TASK_ID), false);
  assert.equal(appWorkflowCatalogForEnvironment({}).some((entry) => entry.definition.id === RUN_INTERVENTION_FIXTURE_TASK_ID), false);
  const task = automationTasksForEnvironment(environment).find((candidate) => candidate.id === RUN_INTERVENTION_FIXTURE_TASK_ID);
  assert.ok(task);
  assert.deepEqual([task.kind, task.credentialKeys, task.dependencies], ["crawler", [], []]);
  assert.ok(appWorkflowCatalogForEnvironment(environment).some((entry) => entry.definition.id === RUN_INTERVENTION_FIXTURE_TASK_ID));
});
