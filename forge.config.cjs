const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const { packagedBrowserArtifactIgnore } = require("./scripts/desktop-browser-payload.cjs");

const { existsSync } = require("node:fs");
const path = require("node:path");
const { UBUNTU_APT_PACKAGES } = require("./scripts/ubuntu-environment.mjs");

const shouldSign = process.env.OCTOPUSBEAK_SIGN === "1";
const notaryProfile = process.env.OCTOPUSBEAK_NOTARY_PROFILE || "OctopusBeakNotary";
const notaryKeychain = process.env.OCTOPUSBEAK_NOTARY_KEYCHAIN;

// ADR 0141: the .deb installs the public key apt trusts for this repository. A release builds with the
// maintainer's keyring committed next to the maintainer scripts; CI's install test names a throwaway one.
const debDirectory = path.join(__dirname, "packaging", "deb");
const debKeyring = process.env.OCTOPUSBEAK_APT_KEYRING || path.join(debDirectory, "octopusbeak-archive-keyring.gpg");
const linuxPackage = process.platform === "linux";
// onnxruntime-node ships every platform and the CUDA and TensorRT providers, about 450 MB the CPU-only
// vision inference never loads. Left out of the Ubuntu package so the .deb stays small (ADR 0141).
const onnxRuntimeIgnoredOnLinux =
  /^\/node_modules\/onnxruntime-node\/bin\/napi-v6\/(?:darwin|win32|linux\/arm64)(?:$|\/)|^\/node_modules\/onnxruntime-node\/bin\/napi-v6\/linux\/x64\/libonnxruntime_providers_(?:cuda|tensorrt)\.so$/u;

module.exports = {
  packagerConfig: {
    name: "OctopusBeak",
    executableName: "OctopusBeak",
    appBundleId: "app.octopusbeak.desktop",
    appCategoryType: "public.app-category.finance",
    icon: "electron/assets/icon",
    asar: false,
    ...(linuxPackage
      ? {
          extraResource: [
            debKeyring,
            path.join(debDirectory, "octopusbeak.sources"),
            path.join(debDirectory, "octopusbeak.apparmor"),
          ],
        }
      : {}),
    ignore: [
      /^\/\.git($|\/)/,
      /^\/\.githooks($|\/)/,
      /^\/\.github($|\/)/,
      /^\/\.codex($|\/)/,
      /^\/\.agents($|\/)/,
      /^\/\.svelte-kit($|\/)/,
      /^\/\.env(?:\..*)?$/,
      /^\/\.libretto($|\/)/,
      /^\/\.superpowers($|\/)/,
      /^\/site($|\/)/,
      /^\/data($|\/)/,
      packagedBrowserArtifactIgnore,
      ...(linuxPackage ? [onnxRuntimeIgnoredOnLinux] : []),
      /^\/docs($|\/)/,
      /^\/packaging($|\/)/,
      /^\/downloads($|\/)/,
      /^\/playground($|\/)/,
      /^\/out($|\/)/,
      /^\/reports($|\/)/,
      /^\/scripts\/tdcc-probe(?:\.mjs$|$|\/)/,
      /^\/scripts\/esun-deposit-probe(?:\.ts$|$|\/)/,
    ],
    ...(shouldSign
      ? {
          osxSign: {},
          osxNotarize: {
            keychainProfile: notaryProfile,
            ...(notaryKeychain ? { keychain: notaryKeychain } : {}),
          },
        }
      : {}),
  },
  hooks: {
    // Checked when packaging, not when this file loads, so tests and tools can read the config anywhere.
    prePackage: async () => {
      if (linuxPackage && !existsSync(debKeyring)) {
        throw new Error(`No apt keyring at ${debKeyring}; export the signing public key there or set OCTOPUSBEAK_APT_KEYRING.`);
      }
      // extraResource copies a file under its own name, and postinst looks for exactly this one.
      if (linuxPackage && path.basename(debKeyring) !== "octopusbeak-archive-keyring.gpg") {
        throw new Error(`The apt keyring must be named octopusbeak-archive-keyring.gpg, not ${path.basename(debKeyring)}.`);
      }
    },
  },
  plugins: [
    // The packaged binary refuses to start as plain Node or under a debugger.
    // GrantFileProtocolExtraPrivileges stays on: without it a file:// page cannot
    // read localStorage, and the move to app:// carries preferences out of file://.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
    }),
  ],
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {
        format: "ULFO",
        icon: "electron/assets/icon.icns",
        background: "electron/assets/dmg-background.png",
        iconSize: 112,
        contents: ({ appPath }) => [
          { x: 170, y: 220, type: "file", path: appPath },
          { x: 490, y: 220, type: "link", path: "/Applications" },
          { x: 170, y: 640, type: "position", path: ".background" },
          { x: 490, y: 640, type: "position", path: ".VolumeIcon.icns" },
        ],
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
    {
      name: "@electron-forge/maker-deb",
      platforms: ["linux"],
      config: {
        options: {
          name: "octopusbeak",
          productName: "OctopusBeak",
          bin: "OctopusBeak",
          icon: path.join(__dirname, "electron", "assets", "icon.png"),
          genericName: "Personal finance",
          description: "Local-first personal finance for Taiwan: collect and review your own bank data.",
          categories: ["Office", "Finance"],
          section: "utils",
          maintainer: "OctopusBeak",
          homepage: "https://github.com/jimmylin0979/OctopusBeak",
          // The libraries both Ubuntu 24.04 and 26.04 ship; setup-ubuntu.sh installs the same list.
          depends: [...UBUNTU_APT_PACKAGES],
          scripts: {
            postinst: path.join(debDirectory, "postinst"),
            postrm: path.join(debDirectory, "postrm"),
          },
        },
      },
    },
  ],
};
