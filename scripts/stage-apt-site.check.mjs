import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = join(import.meta.dirname, "stage-apt-site.sh");

/** A fake `gh` answering `release view` and `release download` the way the script's cases need. */
function harness({ view, viewFails = false, archive }) {
  const root = mkdtempSync(join(tmpdir(), "stage-apt-"));
  const bin = join(root, "bin");
  const site = join(root, "site");
  mkdirSync(bin);
  mkdirSync(site);
  if (archive) {
    const tree = join(root, "tree");
    mkdirSync(join(tree, "dists", "stable"), { recursive: true });
    writeFileSync(join(tree, "dists", "stable", "InRelease"), "signed");
    spawnSync("tar", ["-C", tree, "-cf", join(root, "apt-repo.tar"), "."]);
  }
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
if [[ "$1 $2" == "release view" ]]; then
  ${viewFails ? `echo ${JSON.stringify(view)} >&2; exit 1` : `printf '%b\\n' ${JSON.stringify(view)}`}
  exit 0
fi
if [[ "$1 $2" == "release download" ]]; then
  cp ${JSON.stringify(join(root, "apt-repo.tar"))} "$6/apt-repo.tar"
  exit 0
fi
exit 9
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const result = spawnSync("bash", [script, site], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  return { result, site };
}

test("a repository with no release ships the site without apt", () => {
  const { result, site } = harness({ view: "release not found", viewFails: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(site, "apt")), false);
});

test("a newest release without apt-repo.tar ships the site without apt", () => {
  const { result, site } = harness({ view: "OctopusBeak-arm64.dmg\nSHA256SUMS.txt" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(site, "apt")), false);
});

test("the newest release's apt-repo.tar is unpacked under apt/", () => {
  const { result, site } = harness({ view: "OctopusBeak-arm64.dmg\napt-repo.tar", archive: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(site, "apt", "dists", "stable", "InRelease"), "utf8"), "signed");
});

test("any other failure to read the release stops the deploy", () => {
  const { result, site } = harness({ view: "HTTP 502: bad gateway", viewFails: true });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(site, "apt")), false);
});
