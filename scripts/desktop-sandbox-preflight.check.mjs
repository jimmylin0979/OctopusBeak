import assert from "node:assert/strict";
import test from "node:test";
import { decideSandboxLaunch } from "./desktop-sandbox-preflight.mjs";

const SUID_FAILURE = {
  status: 133,
  stderr:
    "[1:1115/200250.686555:FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166] " +
    "The SUID sandbox helper binary was found, but is not configured correctly.",
};

test("launches proceed when the sandbox is not the problem", () => {
  const ok = { status: 0, stderr: "" };
  const unrelated = { status: 1, stderr: "Error: cannot open display" };
  assert.deepEqual(decideSandboxLaunch({ platform: "linux", args: [], probe: ok }), { proceed: true });
  assert.deepEqual(decideSandboxLaunch({ platform: "linux", args: [], probe: unrelated }), { proceed: true });
  assert.deepEqual(decideSandboxLaunch({ platform: "darwin", args: [], probe: SUID_FAILURE }), { proceed: true });
});

test("an explicit --no-sandbox launch proceeds even though the sandbox cannot start", () => {
  const decision = decideSandboxLaunch({ platform: "linux", args: ["--no-sandbox"], probe: SUID_FAILURE });
  assert.deepEqual(decision, { proceed: true });
});

test("a Linux launch whose sandbox cannot start stops and names both ways forward", () => {
  const decision = decideSandboxLaunch({ platform: "linux", args: [], probe: SUID_FAILURE });
  assert.equal(decision.proceed, false);
  assert.match(decision.message, /desktop-apparmor-profile\.mjs/u);
  assert.match(decision.message, /--no-sandbox/u);
});
