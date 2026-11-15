const SANDBOX_FAILURE = /sandbox/iu;

/**
 * Decide whether a Linux development launch can start Electron's sandbox.
 * `probe` is the outcome of running `electron --version`, which aborts with a
 * sandbox error before any window opens when the sandbox cannot start.
 */
export function decideSandboxLaunch({ platform, args, probe }) {
  if (args.includes("--no-sandbox")) return { proceed: true };
  if (platform === "linux" && probe.status !== 0 && SANDBOX_FAILURE.test(probe.stderr)) {
    return {
      proceed: false,
      message: [
        "[desktop:dev] Electron's Chromium sandbox cannot start on this checkout.",
        "Either register an AppArmor profile for this checkout (keeps the sandbox on):",
        "  node scripts/desktop-apparmor-profile.mjs",
        "or pass --no-sandbox explicitly to run without it:",
        "  npm run desktop:dev -- --no-sandbox",
      ].join("\n"),
    };
  }
  return { proceed: true };
}
