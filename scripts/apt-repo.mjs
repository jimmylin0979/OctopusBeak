import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";

/** ADR 0141: one suite, one component, one architecture. */
const SUITE = "stable";
const COMPONENT = "main";
const ARCHITECTURE = "amd64";
const PACKAGE = "octopusbeak";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function digests(path) {
  const bytes = readFileSync(path);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: statSync(path).size };
}

/**
 * Builds the signed apt tree for the given .deb files under outDir: the pool, the Packages index, and a
 * Release signed both as InRelease and as Release.gpg. gnupgHome and signingKey name the signing subkey
 * (ADR 0141); a trailing "!" is added so gpg uses exactly that subkey. The passphrase goes to gpg on a
 * pipe, never on the command line, where another process could read it.
 */
export function buildAptRepository({ debs, outDir, gnupgHome, signingKey, passphrase = "", date = new Date() }) {
  const pool = join(outDir, "pool", COMPONENT, PACKAGE[0], PACKAGE);
  mkdirSync(pool, { recursive: true });
  for (const deb of debs) copyFileSync(deb, join(pool, basename(deb)));

  const binary = join(outDir, "dists", SUITE, COMPONENT, `binary-${ARCHITECTURE}`);
  mkdirSync(binary, { recursive: true });
  // Run from outDir so each Filename is relative to the repository root, as apt resolves it.
  const packages = run("dpkg-scanpackages", ["--arch", ARCHITECTURE, "pool"], { cwd: outDir });
  writeFileSync(join(binary, "Packages"), packages);
  writeFileSync(join(binary, "Packages.gz"), gzipSync(packages, { level: 9 }));

  const indexes = ["Packages", "Packages.gz"].map((name) => {
    const { sha256, size } = digests(join(binary, name));
    return ` ${sha256} ${String(size).padStart(16)} ${COMPONENT}/binary-${ARCHITECTURE}/${name}`;
  });
  const release = [
    "Origin: OctopusBeak",
    "Label: OctopusBeak",
    `Suite: ${SUITE}`,
    `Codename: ${SUITE}`,
    `Date: ${date.toUTCString()}`,
    `Architectures: ${ARCHITECTURE}`,
    `Components: ${COMPONENT}`,
    "SHA256:",
    ...indexes,
    "",
  ].join("\n");
  const dists = join(outDir, "dists", SUITE);
  writeFileSync(join(dists, "Release"), release);

  const sign = (mode, output) =>
    run("gpg", [
      "--homedir", gnupgHome, "--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-fd", "0",
      "--local-user", `${signingKey}!`, mode, "--output", join(dists, output), join(dists, "Release"),
    ], { input: `${passphrase}\n` });
  sign("--clearsign", "InRelease");
  sign("--detach-sign", "Release.gpg");
}
