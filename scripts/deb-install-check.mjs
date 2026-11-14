// CI-only install test for the Ubuntu package (ADR 0141). It changes the machine it runs on (sudo apt
// install, upgrade and purge), so run it on a disposable runner, never a workstation.
//
//   node scripts/deb-install-check.mjs key <workdir>            make a throwaway signing key and keyring
//   node scripts/deb-install-check.mjs verify <workdir> <deb>   install, upgrade and purge <deb>
//
// `key` runs before the build so the .deb is built with OCTOPUSBEAK_APT_KEYRING=<workdir>/octopusbeak-archive-keyring.gpg.
// `verify` then signs a local apt repository with that key, so the keyring the .deb installed is the one
// apt checks.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import assert from "node:assert/strict";
import { buildAptRepository } from "./apt-repo.mjs";

const KEYRING = "/usr/share/keyrings/octopusbeak-archive-keyring.gpg";
const SOURCE = "/etc/apt/sources.list.d/octopusbeak.sources";
const PROFILE = "/etc/apparmor.d/octopusbeak";
const INSTALL_DIRECTORY = "/usr/lib/octopusbeak";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

const sudo = (command, args) => run("sudo", [command, ...args], { env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" } });

function makeKey(workdir) {
  mkdirSync(workdir, { recursive: true });
  const gnupgHome = join(workdir, "gnupg");
  mkdirSync(gnupgHome, { recursive: true, mode: 0o700 });
  const gpg = (...args) => run("gpg", ["--homedir", gnupgHome, "--batch", "--pinentry-mode", "loopback", "--passphrase", "", ...args]);
  gpg("--quick-generate-key", "OctopusBeak CI <ci@example.invalid>", "ed25519", "cert", "never");
  const fingerprint = gpg("--list-keys", "--with-colons").split("\n").find((line) => line.startsWith("fpr:")).split(":")[9];
  gpg("--quick-add-key", fingerprint, "ed25519", "sign", "1y");
  const subkey = gpg("--list-keys", "--with-colons", "--with-subkey-fingerprints").split("\n").filter((line) => line.startsWith("fpr:")).map((line) => line.split(":")[9]).at(-1);
  writeFileSync(join(workdir, "octopusbeak-archive-keyring.gpg"), run("gpg", ["--homedir", gnupgHome, "--export", fingerprint], { encoding: "buffer" }));
  writeFileSync(join(workdir, "subkey"), subkey);
  console.log(`keyring ${join(workdir, "octopusbeak-archive-keyring.gpg")} subkey ${subkey}`);
}

/** The same package one version later: only the Version field differs, so the upgrade path is the real one. */
function bumpedDeb(deb, workdir) {
  const tree = join(workdir, "bumped-tree");
  run("dpkg-deb", ["-R", deb, tree]);
  const control = join(tree, "DEBIAN", "control");
  const text = readFileSync(control, "utf8");
  const version = /^Version: (.+)$/m.exec(text)[1];
  const next = `${version}+ci1`;
  writeFileSync(control, text.replace(/^Version: .+$/m, `Version: ${next}`));
  const output = join(workdir, `octopusbeak_${next}_amd64.deb`);
  // Uncompressed: this copy is only ever installed once, and recompressing 1 GB would dominate the run.
  run("dpkg-deb", ["-Znone", "-b", tree, output]);
  return { path: output, version, next };
}

function installedVersion() {
  const result = spawnSync("dpkg-query", ["-W", "-f=${Version}", "octopusbeak"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}

function verify(workdir, debArgument) {
  const deb = resolve(debArgument);
  const gnupgHome = join(workdir, "gnupg");
  const subkey = readFileSync(join(workdir, "subkey"), "utf8").trim();
  const bumped = bumpedDeb(deb, workdir);

  // 1. Install the .deb the way a person does; apt resolves Depends on this Ubuntu.
  sudo("apt-get", ["install", "--yes", deb]);
  assert.equal(installedVersion(), bumped.version, "the first version is installed");
  assert.ok(existsSync(KEYRING), "postinst installs the keyring");
  assert.match(readFileSync(SOURCE, "utf8"), /Signed-By: \/usr\/share\/keyrings\/octopusbeak-archive-keyring\.gpg/, "postinst installs the apt source");
  assert.ok(existsSync(PROFILE), "postinst installs the AppArmor profile");
  const loaded = spawnSync("sudo", ["grep", "-q", "octopusbeak", "/sys/kernel/security/apparmor/profiles"]);
  assert.equal(loaded.status, 0, "the AppArmor profile is loaded into the kernel");

  // 2. Upgrade through apt from a signed repository holding the later version. Only the test source is
  // read, so the real Pages URL (not yet live) does not matter; it is verified against the keyring the .deb
  // itself installed.
  const repository = join(workdir, "repository");
  buildAptRepository({ debs: [bumped.path], outDir: repository, gnupgHome, signingKey: subkey });
  for (const directory of [workdir, repository]) chmodSync(directory, 0o755);
  const sources = join(workdir, "sources.d");
  mkdirSync(sources, { recursive: true });
  writeFileSync(
    join(sources, "ci.sources"),
    `Types: deb\nURIs: file://${repository}\nSuites: stable\nComponents: main\nArchitectures: amd64\nSigned-By: ${KEYRING}\n`,
  );
  const only = ["-o", `Dir::Etc::sourceparts=${sources}`, "-o", "Dir::Etc::sourcelist=/dev/null"];
  sudo("apt-get", [...only, "update"]);
  sudo("apt-get", [...only, "install", "--yes", "--only-upgrade", "octopusbeak"]);
  assert.equal(installedVersion(), bumped.next, "apt upgraded to the later version");

  // 3. Remove drops the sandbox profile but keeps the apt source; purge then leaves nothing behind.
  sudo("apt-get", ["remove", "--yes", "octopusbeak"]);
  assert.ok(!existsSync(PROFILE), "remove drops the AppArmor profile");
  assert.ok(existsSync(SOURCE), "remove keeps the apt source");
  sudo("apt-get", ["purge", "--yes", "octopusbeak"]);
  for (const path of [SOURCE, KEYRING, PROFILE, INSTALL_DIRECTORY]) assert.ok(!existsSync(path), `purge leaves no ${path}`);
  console.log(`ok: ${basename(deb)} installed, upgraded to ${bumped.next} through apt, removed and purged`);
}

const [command, workdir, deb] = process.argv.slice(2);
if (command === "key" && workdir) makeKey(resolve(workdir));
else if (command === "verify" && workdir && deb) verify(resolve(workdir), deb);
else {
  console.error("usage: deb-install-check.mjs key <workdir> | verify <workdir> <deb>");
  process.exit(2);
}
