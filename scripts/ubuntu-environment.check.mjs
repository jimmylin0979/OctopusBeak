import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  UBUNTU_APT_PACKAGES,
  electronExecutablePath,
  electronSandboxProfile,
  electronSandboxProfileName,
  parseOsRelease,
  toolchainVersions,
  ubuntuEnvironmentFindings,
} from "./ubuntu-environment.mjs";

const root = resolve(import.meta.dirname, "..");
const setupScript = resolve(root, "scripts", "setup-ubuntu.sh");

function setup(flag) {
  const result = spawnSync("bash", [setupScript, flag], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("setup-ubuntu.sh installs the packages doctor checks", () => {
  assert.deepEqual(setup("--print-packages").trim().split("\n"), [...UBUNTU_APT_PACKAGES]);
});

test("setup-ubuntu.sh writes the profile doctor expects", () => {
  assert.equal(setup("--print-profile"), electronSandboxProfile(electronExecutablePath(root)));
});

test("the profile name is the first 12 hex digits of the path's SHA-256", () => {
  assert.equal(
    electronSandboxProfileName("/home/person/OctopusBeak/node_modules/electron/dist/electron"),
    "octopusbeak-dev-6fc240741fa3",
  );
  assert.notEqual(electronSandboxProfileName("/a"), electronSandboxProfileName("/b"));
});

test("the toolchain comes from .tool-versions and packageManager", () => {
  const versions = toolchainVersions(
    readFileSync(resolve(root, ".tool-versions"), "utf8"),
    JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")),
  );
  assert.deepEqual(versions, { node: "25.9.0", npm: "11.12.1" });
});

const healthy = {
  osRelease: parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\n'),
  arch: "x64",
  nodeVersion: "25.9.0",
  npmVersion: "11.12.1",
  toolchain: { node: "25.9.0", npm: "11.12.1" },
  missingPackages: [],
  userNamespacesRestricted: true,
  profileName: "octopusbeak-dev-000000000000",
  profilePath: "/etc/apparmor.d/octopusbeak-dev-000000000000",
  installedProfile: "profile",
  expectedProfile: "profile",
  electron: { status: "passed", backend: "gnome_libsecret", encryptionAvailable: true },
};

function statuses(probe) {
  return Object.fromEntries(ubuntuEnvironmentFindings(probe).map(({ id, status }) => [id, status]));
}

test("a prepared Ubuntu passes every check", () => {
  assert.ok(Object.values(statuses(healthy)).every((status) => status === "ok"));
});

test("each missing prerequisite fails its own check with a fix", () => {
  const findings = ubuntuEnvironmentFindings({
    ...healthy,
    nodeVersion: "22.22.1",
    missingPackages: ["gnome-keyring"],
    installedProfile: null,
  });
  for (const id of ["node", "packages", "sandbox-profile"]) {
    const finding = findings.find((entry) => entry.id === id);
    assert.equal(finding.status, "fail", id);
    assert.ok(finding.fix.length > 0, id);
  }
});

test("no profile is needed where user namespaces are not restricted", () => {
  assert.equal(statuses({ ...healthy, userNamespacesRestricted: false, installedProfile: null })["sandbox-profile"], "ok");
});

test("a basic_text backend fails the keyring check", () => {
  assert.equal(statuses({ ...healthy, electron: { ...healthy.electron, backend: "basic_text" } }).keyring, "fail");
});

test("an unsupported release only warns", () => {
  const result = statuses({ ...healthy, osRelease: { ID: "debian", VERSION_ID: "13" } });
  assert.equal(result.os, "warn");
});

test("a skipped Electron probe does not fail the doctor", () => {
  const result = statuses({ ...healthy, electron: { status: "skipped", reason: "no display" } });
  assert.equal(result.electron, "skip");
  assert.equal(result.keyring, undefined);
});
