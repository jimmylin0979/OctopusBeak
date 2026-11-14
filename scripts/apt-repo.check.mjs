import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildAptRepository } from "./apt-repo.mjs";

const available = ["dpkg-deb", "dpkg-scanpackages", "gpg", "apt-get", "apt-cache"].every(
  (tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0,
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

/** A package with the same name and layout as OctopusBeak's, without its 300 MB. */
function fixtureDeb(directory, version) {
  const tree = join(directory, `pkg-${version}`);
  mkdirSync(join(tree, "DEBIAN"), { recursive: true });
  mkdirSync(join(tree, "usr", "share", "octopusbeak"), { recursive: true });
  writeFileSync(
    join(tree, "DEBIAN", "control"),
    `Package: octopusbeak\nVersion: ${version}\nArchitecture: amd64\nMaintainer: Test <test@example.invalid>\nDescription: fixture\n`,
  );
  writeFileSync(join(tree, "usr", "share", "octopusbeak", "version"), version);
  const file = join(directory, `octopusbeak_${version}_amd64.deb`);
  run("dpkg-deb", ["--build", "--root-owner-group", tree, file]);
  return file;
}

/** Throwaway key: an offline primary that certifies a signing subkey, as ADR 0141 describes. */
function throwawayKey(home) {
  const env = { ...process.env, GNUPGHOME: home };
  run("gpg", ["--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-generate-key", "OctopusBeak Test <test@example.invalid>", "ed25519", "cert", "never"], { env });
  const fingerprint = run("gpg", ["--batch", "--with-colons", "--list-keys"], { env })
    .split("\n").find((line) => line.startsWith("fpr:"))?.split(":")[9];
  assert.ok(fingerprint);
  run("gpg", ["--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-add-key", fingerprint, "ed25519", "sign", "never"], { env });
  const subkey = run("gpg", ["--batch", "--with-colons", "--list-keys"], { env })
    .split("\n").filter((line) => line.startsWith("fpr:"))[1]?.split(":")[9];
  assert.ok(subkey);
  const keyring = join(home, "keyring.gpg");
  run("gpg", ["--batch", "--export", "--output", keyring], { env });
  return { env, subkey, keyring };
}

/** Real apt, no root: private state, one source, the keyring named by Signed-By. */
function apt(root, repository, keyring) {
  const sources = join(root, "sources.list.d");
  mkdirSync(sources, { recursive: true });
  mkdirSync(join(root, "state", "lists", "partial"), { recursive: true });
  mkdirSync(join(root, "cache", "archives", "partial"), { recursive: true });
  writeFileSync(
    join(sources, "octopusbeak.sources"),
    `Types: deb\nURIs: file://${repository}\nSuites: stable\nComponents: main\nArchitectures: amd64\nSigned-By: ${keyring}\n`,
  );
  const options = [
    "-o", `Dir::Etc::sourcelist=/dev/null`, "-o", `Dir::Etc::sourceparts=${sources}`,
    "-o", `Dir::State=${join(root, "state")}`, "-o", `Dir::Cache=${join(root, "cache")}`,
    "-o", "Dir::Etc::trusted=/dev/null", "-o", `Dir::Etc::trustedparts=${join(root, "none")}`,
    "-o", "APT::Sandbox::User=", "-o", "Debug::NoLocking=1",
  ];
  return {
    update: () => spawnSync("apt-get", [...options, "update"], { encoding: "utf8" }),
    candidate: () => run("apt-cache", [...options, "policy", "octopusbeak"]).match(/Candidate: (\S+)/u)?.[1],
    download: (cwd) => run("apt-get", [...options, "download", "octopusbeak"], { cwd }),
  };
}

test("apt installs a repository signed by the subkey and finds the newer version after a rebuild", { skip: !available }, () => {
  const root = mkdtempSync("/tmp/ob-apt-");
  try {
    const home = join(root, "gnupg");
    mkdirSync(home, { mode: 0o700 });
    const { env, subkey, keyring } = throwawayKey(home);
    const repository = join(root, "repo");

    buildAptRepository({ debs: [fixtureDeb(root, "1.0.0")], outDir: repository, gnupgHome: home, signingKey: subkey });
    assert.deepEqual(
      readdirSync(join(repository, "pool", "main", "o", "octopusbeak")),
      ["octopusbeak_1.0.0_amd64.deb"],
    );
    assert.ok(existsSync(join(repository, "dists", "stable", "InRelease")));

    const first = apt(join(root, "apt1"), repository, keyring);
    const updated = first.update();
    assert.equal(updated.status, 0, updated.stdout + updated.stderr);
    assert.equal(first.candidate(), "1.0.0");
    const downloads = join(root, "downloads");
    mkdirSync(downloads);
    first.download(downloads);
    assert.deepEqual(readdirSync(downloads), ["octopusbeak_1.0.0_amd64.deb"]);

    // A later release replaces the tree: only the newest .deb is served (ADR 0141).
    rmSync(repository, { recursive: true });
    buildAptRepository({ debs: [fixtureDeb(root, "1.1.0")], outDir: repository, gnupgHome: home, signingKey: subkey });
    assert.deepEqual(readdirSync(join(repository, "pool", "main", "o", "octopusbeak")), ["octopusbeak_1.1.0_amd64.deb"]);
    first.update();
    assert.equal(first.candidate(), "1.1.0", "apt upgrade would offer the new version");
    void env;
  } finally {
    spawnSync("gpgconf", ["--homedir", join(root, "gnupg"), "--kill", "all"]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("apt refuses a repository whose metadata was altered after signing", { skip: !available }, () => {
  const root = mkdtempSync("/tmp/ob-apt-");
  try {
    const home = join(root, "gnupg");
    mkdirSync(home, { mode: 0o700 });
    const { subkey, keyring } = throwawayKey(home);
    const repository = join(root, "repo");
    buildAptRepository({ debs: [fixtureDeb(root, "1.0.0")], outDir: repository, gnupgHome: home, signingKey: subkey });
    const inRelease = join(repository, "dists", "stable", "InRelease");
    writeFileSync(inRelease, readFileSync(inRelease, "utf8").replace("Suite: stable", "Suite: evil"));
    const result = apt(join(root, "apt"), repository, keyring).update();
    assert.notEqual(result.status, 0, "a tampered InRelease must fail apt-get update");
    assert.match(result.stdout + result.stderr, /BADSIG|not signed|signature|invalid/iu);
  } finally {
    spawnSync("gpgconf", ["--homedir", join(root, "gnupg"), "--kill", "all"]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("apt refuses a repository signed by a key the keyring does not hold", { skip: !available }, () => {
  const root = mkdtempSync("/tmp/ob-apt-");
  try {
    const trusted = join(root, "trusted");
    const rogue = join(root, "rogue");
    mkdirSync(trusted, { mode: 0o700 });
    mkdirSync(rogue, { mode: 0o700 });
    const { keyring } = throwawayKey(trusted);
    const attacker = throwawayKey(rogue);
    const repository = join(root, "repo");
    buildAptRepository({ debs: [fixtureDeb(root, "1.0.0")], outDir: repository, gnupgHome: rogue, signingKey: attacker.subkey });
    const result = apt(join(root, "apt"), repository, keyring).update();
    assert.notEqual(result.status, 0, "a repository signed by another key must fail apt-get update");
    assert.match(result.stdout + result.stderr, /NO_PUBKEY|not signed|signature|invalid/iu);
  } finally {
    for (const name of ["trusted", "rogue"]) spawnSync("gpgconf", ["--homedir", join(root, name), "--kill", "all"]);
    rmSync(root, { recursive: true, force: true });
  }
});
