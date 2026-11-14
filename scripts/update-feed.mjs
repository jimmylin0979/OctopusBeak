import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The installed App reads releases/latest/download/<this> (src/lib/settings/app-updates.ts). */
export const UPDATE_FEED_FILE = "update-feed-darwin-arm64.json";
/** The Ubuntu App reads this one and only announces it; apt installs the .deb (ADR 0141). */
export const LINUX_UPDATE_FEED_FILE = "update-feed-linux-x64.json";

/** Each target's release asset, the feed that names it, and the repository that serves both. */
const TARGETS = {
  "darwin-arm64": {
    feedFile: UPDATE_FEED_FILE,
    releases: "https://github.com/WangWilly/OctopusBeak/releases/download",
    assetName: (version) => `OctopusBeak-darwin-arm64-${version}.zip`,
  },
  "linux-x64": {
    feedFile: LINUX_UPDATE_FEED_FILE,
    releases: "https://github.com/jimmylin0979/OctopusBeak/releases/download",
    assetName: (version) => `octopusbeak_${version}_amd64.deb`,
  },
};

export function updateZipName(version) {
  return TARGETS["darwin-arm64"].assetName(version);
}

/**
 * The App's own feed (ADR 0083), parsed by parseAppUpdateFeed. Squirrel.Mac never reads it: the App
 * downloads and checks the ZIP itself, then hands it to Squirrel.Mac only to install.
 */
export function updateFeed({ version, publishedAt, size, sha256, target = "darwin-arm64" }) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`Not a release version: ${version}`);
  return {
    schema: 1,
    version,
    name: `OctopusBeak ${version}`,
    pubDate: publishedAt.toISOString(),
    url: `${TARGETS[target].releases}/v${version}/${TARGETS[target].assetName(version)}`,
    size,
    sha256,
  };
}

/** Hashes in chunks: the ZIP is about 430 MB. */
function zipDigest(file) {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(8 * 1024 * 1024);
  const fd = openSync(file, "r");
  let size = 0;
  try {
    for (let read; (read = readSync(fd, buffer)) > 0; size += read) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return { size, sha256: hash.digest("hex") };
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

/** Writes the feed into the make directory, refusing when the ZIP it names was not built. */
export function writeUpdateFeed({ makeDirectory, version, publishedAt, target = "darwin-arm64" }) {
  const { assetName, feedFile } = TARGETS[target];
  const zips = filesUnder(makeDirectory).filter((path) => basename(path) === assetName(version));
  if (zips.length !== 1) {
    throw new Error(`Expected exactly one ${assetName(version)} in ${makeDirectory}, found ${zips.length}.`);
  }
  const feed = updateFeed({ version, publishedAt, target, ...zipDigest(zips[0]) });
  const path = join(makeDirectory, feedFile);
  writeFileSync(path, `${JSON.stringify(feed, null, 2)}\n`);
  return path;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const makeDirectory = resolve(process.argv[2] ?? "out/make");
  const target = process.argv[3] ?? "darwin-arm64";
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(writeUpdateFeed({ makeDirectory, version, publishedAt: new Date(), target }));
}
