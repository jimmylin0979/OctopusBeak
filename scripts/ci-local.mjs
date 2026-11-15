// Run the PR Tests workflow locally with `act` in Docker (manual; not a git hook).
//   npm run ci:local                       # typecheck + every test lane
//   npm run ci:local -- typecheck unit-1   # selected jobs
// Jobs: typecheck unit-1 unit-2 unit-3 unit-4 browser electron
// Docs: docs/runbooks/local-ci.md
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = join(ROOT, ".github/workflows/pr-tests.yml");

const JOBS = {
  typecheck: { job: "typecheck" },
  "unit-1": { job: "lane", matrix: "name:unit 1/4" },
  "unit-2": { job: "lane", matrix: "name:unit 2/4" },
  "unit-3": { job: "lane", matrix: "name:unit 3/4" },
  "unit-4": { job: "lane", matrix: "name:unit 4/4" },
  browser: { job: "lane", matrix: "name:browser" },
  electron: { job: "lane", matrix: "name:electron-cdp and performance" },
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { stdio: "inherit", cwd: ROOT, ...options });
}

const selected = process.argv.slice(2);
const names = selected.length > 0 ? selected : Object.keys(JOBS);
for (const name of names) {
  if (!JOBS[name]) fail(`Unknown job '${name}'. Valid: ${Object.keys(JOBS).join(" ")}`);
}

// act: standalone binary, or the `gh act` extension.
const actCommand = spawnSync("act", ["--version"], { stdio: "ignore" }).status === 0
  ? { command: "act", prefix: [] }
  : spawnSync("gh", ["act", "--version"], { stdio: "ignore" }).status === 0
    ? { command: "gh", prefix: ["act"] }
    : fail("act not found. Install it (https://nektosact.com/installation/gh.html).");

// Docker Desktop on Linux has no /var/run/docker.sock; use its own socket.
const env = { ...process.env };
const desktopSocket = join(homedir(), ".docker/desktop/docker.sock");
if (!env.DOCKER_HOST && !existsSync("/var/run/docker.sock") && existsSync(desktopSocket)) {
  env.DOCKER_HOST = `unix://${desktopSocket}`;
}
if (spawnSync("docker", ["info"], { stdio: "ignore", env }).status !== 0) {
  fail("Docker daemon is not reachable. Start Docker first.");
}

// The Node version comes from the workflow so the image follows CI.
const workflowText = readFileSync(WORKFLOW, "utf8");
const nodeVersion = /node-version:\s*"?([0-9.]+)"?/u.exec(workflowText)?.[1];
if (!nodeVersion) fail("Could not read node-version from pr-tests.yml");

const work = mkdtempSync(join(tmpdir(), "ci-local-"));

// Build the runner image. An empty DOCKER_CONFIG skips credential helpers,
// which can prompt (gpg/pass) and are not needed for the public ubuntu image.
const dockerConfig = join(work, "docker-config");
spawnSync("mkdir", ["-p", dockerConfig]);
writeFileSync(join(dockerConfig, "config.json"), "{}\n");
const image = `octopusbeak-ci-local:node-${nodeVersion}`;
const build = run("docker", ["build", "-q", "--build-arg", `NODE_VERSION=${nodeVersion}`, "-t", image, "scripts/ci-local"], {
  env: { ...env, DOCKER_CONFIG: dockerConfig },
  stdio: ["inherit", "ignore", "inherit"],
});
if (build.status !== 0) fail("docker build failed");

// act's artifact server does not understand upload-artifact v7, so the lane
// report upload fails under act. Run a temporary copy without that one step;
// the repository workflow is not modified.
const localWorkflow = join(work, "pr-tests.yml");
const stripped = workflowText.replace(/\n {6}- name: Upload lane reports\n[\s\S]*?retention-days: 14\n/u, "\n");
if (stripped === workflowText) fail("Could not find the 'Upload lane reports' step to skip; update scripts/ci-local.mjs.");
writeFileSync(localWorkflow, stripped);
const eventFile = join(work, "event.json");
writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 0 } }));

// A git worktree's .git file points into the main repository; mount that
// directory read-only at the same path so git (and LFS attribute checks) work.
const gitCommonDir = resolve(ROOT, spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: ROOT, encoding: "utf8" }).stdout.trim());
const mounts = existsSync(join(ROOT, ".git")) && gitCommonDir !== join(ROOT, ".git") ? ["-v", `${gitCommonDir}:${gitCommonDir}:ro`] : [];

// GitHub's runner has 4 vCPUs. Without a cap the suites start far more
// processes on a big Docker VM and get OOM-killed. /dev/shm needs room for Chromium.
const cpuCount = Math.min(4, cpus().length);
const containerOptions = [
  "--security-opt", "seccomp=unconfined",
  "--shm-size=2g",
  `--cpus=${cpuCount}`,
  `--cpuset-cpus=0-${cpuCount - 1}`,
  ...mounts,
].join(" ");

const failed = [];
for (const name of names) {
  const { job, matrix } = JOBS[name];
  console.log(`\n=== ${name} ===`);
  // Jobs run one at a time: act starts every matrix entry in parallel
  // regardless of --concurrent-jobs, which exhausts memory.
  const args = [
    ...actCommand.prefix, "pull_request",
    "-e", eventFile, "-W", localWorkflow, "-j", job,
    ...(matrix ? ["--matrix", matrix] : []),
    "-P", `ubuntu-24.04=${image}`, "--pull=false",
    "--container-options", containerOptions,
  ];
  const result = run(actCommand.command, args, { env });
  console.log(result.status === 0 ? `--- PASS: ${name}` : `--- FAIL: ${name}`);
  if (result.status !== 0) failed.push(name);
}

console.log(failed.length > 0 ? `\nCI-LOCAL FAILED: ${failed.join(" ")}` : `\nCI-LOCAL PASSED: ${names.join(" ")}`);
process.exit(failed.length > 0 ? 1 : 0);
