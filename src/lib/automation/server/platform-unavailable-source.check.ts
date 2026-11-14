import assert from "node:assert/strict";
import test from "node:test";
import { automationGroupEnabledStatus } from "./settings.ts";
import { AUTOMATION_CREDENTIAL_GROUPS } from "./tasks.ts";
import { platformUnavailable } from "../types.ts";

const yuantaTrade = AUTOMATION_CREDENTIAL_GROUPS.find((group) => group.id === "yuanta-trade");

test("Yuanta Trade is Platform-unavailable on Linux only", () => {
  assert.ok(yuantaTrade);
  assert.equal(platformUnavailable(yuantaTrade, "linux"), true);
  assert.equal(platformUnavailable(yuantaTrade, "darwin"), false);
  const others = AUTOMATION_CREDENTIAL_GROUPS.filter((group) => group.id !== "yuanta-trade");
  assert.ok(others.every((group) => !platformUnavailable(group, "linux")));
});

test("a Platform-unavailable source stays off even when settings.json turns it on", () => {
  assert.ok(yuantaTrade);
  const settings = { [yuantaTrade.enabledKey]: "true" };
  assert.equal(automationGroupEnabledStatus(settings, "linux")["yuanta-trade"], false);
  assert.equal(automationGroupEnabledStatus(settings, "darwin")["yuanta-trade"], true);
});
