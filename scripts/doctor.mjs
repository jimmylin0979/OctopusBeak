// Checks that this Ubuntu machine can run OctopusBeak from source. It changes
// nothing: each failure prints the command that fixes it.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UBUNTU_APT_PACKAGES,
  electronExecutablePath,
  electronSandboxProfile,
  electronSandboxProfileName,
  parseOsRelease,
  toolchainVersions,
  ubuntuEnvironmentFindings,
} from "./ubuntu-environment.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readOptional(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function npmVersion() {
  const result = spawnSync("npm", ["--version"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function missingPackages() {
  return UBUNTU_APT_PACKAGES.filter((name) => {
    const result = spawnSync("dpkg-query", ["-W", "-f=${Status}", name], { encoding: "utf8" });
    return result.status !== 0 || !result.stdout.includes("install ok installed");
  });
}

function probeElectron(electronPath) {
  if (!existsSync(electronPath)) {
    return Promise.resolve({ status: "skipped", reason: "Electron is not installed", fix: ["npm install", "npx --no install-electron"] });
  }
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return Promise.resolve({ status: "skipped", reason: "no display", fix: ["Run npm run doctor from a desktop session, or under xvfb-run."] });
  }
  const userData = mkdtempSync(join(tmpdir(), "octopusbeak-doctor-"));
  return new Promise((resolveProbe) => {
    const child = spawn(electronPath, [
      "--disable-gpu",
      `--user-data-dir=${userData}`,
      ...process.argv.slice(2).filter((arg) => arg.startsWith("--password-store=")),
      join(projectRoot, "scripts", "ubuntu-electron-probe.cjs"),
    ], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const finish = (result) => {
      clearTimeout(timer);
      rmSync(userData, { recursive: true, force: true });
      resolveProbe(result);
    };
    child.once("error", () => finish({ status: "failed", reason: "could not launch Electron" }));
    child.once("exit", () => {
      const line = output.split("\n").find((entry) => entry.startsWith("OCTOPUSBEAK_PROBE "));
      if (line) return finish(JSON.parse(line.slice("OCTOPUSBEAK_PROBE ".length)));
      const sandboxError = /No usable sandbox|setuid sandbox|zygote/iu.test(errors);
      finish({ status: "failed", reason: sandboxError ? "the sandbox is blocked" : "Electron exited before the window loaded" });
    });
  });
}

if (process.platform !== "linux") {
  console.log("npm run doctor checks Ubuntu machines only; macOS needs no extra setup.");
  process.exit(0);
}

const electronPath = electronExecutablePath(projectRoot);
const profileName = electronSandboxProfileName(electronPath);
const profilePath = `/etc/apparmor.d/${profileName}`;
const findings = ubuntuEnvironmentFindings({
  osRelease: parseOsRelease(readOptional("/etc/os-release") ?? ""),
  arch: process.arch,
  nodeVersion: process.versions.node,
  npmVersion: npmVersion(),
  toolchain: toolchainVersions(
    readFileSync(join(projectRoot, ".tool-versions"), "utf8"),
    JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")),
  ),
  missingPackages: missingPackages(),
  userNamespacesRestricted: readOptional("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")?.trim() === "1",
  profileName,
  profilePath,
  installedProfile: readOptional(profilePath),
  expectedProfile: electronSandboxProfile(electronPath),
  electron: await probeElectron(electronPath),
});

const marks = { ok: "✔", warn: "!", fail: "✘", skip: "-" };
for (const finding of findings) {
  console.log(`${marks[finding.status]} ${finding.summary}`);
  for (const line of finding.fix) console.log(`    ${line}`);
}
const failed = findings.filter((finding) => finding.status === "fail").length;
console.log(failed === 0 ? "\nThis machine can run OctopusBeak from source." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
