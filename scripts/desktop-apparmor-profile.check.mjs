import assert from "node:assert/strict";
import test from "node:test";
import { apparmorProfileFor } from "./desktop-apparmor-profile.mjs";

// The name and rule below match the profile already registered on a developer
// machine for this exact path, so they are an independent known-good answer.
const ELECTRON = "/home/jimmylin0979/projects/OctopusBeak/node_modules/electron/dist/electron";

test("a checkout's Electron executable gets a stable, path-scoped userns profile", () => {
  const profile = apparmorProfileFor(ELECTRON);
  assert.equal(profile.name, "octopusbeak-dev-bb8f7e966a90");
  assert.match(
    profile.text,
    /^profile octopusbeak-dev-bb8f7e966a90 "\/home\/jimmylin0979\/projects\/OctopusBeak\/node_modules\/electron\/dist\/electron" flags=\(unconfined\) \{$/mu,
  );
  assert.match(profile.text, /^\s+userns,$/mu);
  assert.deepEqual(profile.commands, [
    `sudo tee /etc/apparmor.d/octopusbeak-dev-bb8f7e966a90 >/dev/null <<'EOF'\n${profile.text}EOF`,
    "sudo apparmor_parser -r /etc/apparmor.d/octopusbeak-dev-bb8f7e966a90",
  ]);
});

test("a path that could inject extra profile rules is refused", () => {
  for (const path of [
    '/tmp/a"b/electron',
    "/tmp/a\nb/electron",
    "/tmp/a{b/electron",
    "/tmp/a*b/electron",
    "relative/electron",
  ]) {
    assert.throws(() => apparmorProfileFor(path), /absolute|unsafe/iu, path);
  }
});
