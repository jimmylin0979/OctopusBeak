# Electron's sandbox runs on Ubuntu through an AppArmor profile

Status: accepted

Since Ubuntu 24.04, AppArmor blocks unprivileged user namespaces by default (`kernel.apparmor_restrict_unprivileged_userns=1`). Electron's Chromium sandbox needs a user namespace, so on a stock Ubuntu the App cannot start its sandboxed renderers. The Electron binary that npm installs also ships `chrome-sandbox` without the setuid bit, so Chromium's fallback sandbox is not available either.

**The App keeps its sandbox on Ubuntu by installing an AppArmor profile that grants `userns` to one Electron executable path.** In a source checkout, `scripts/setup-ubuntu.sh` writes the profile `octopusbeak-dev-<first 12 hex digits of the SHA-256 of the Electron path>` for `<checkout>/node_modules/electron/dist/electron` and loads it. `npm run doctor` checks that the profile exists and names the current path. The packaged `.deb` installs an equivalent profile for its own install path, as Chrome and VS Code do. The profile is bound to a path, not to the file's contents, so it survives `npm install`.

## Considered options

- **Make `chrome-sandbox` setuid root.** Rejected. Every `npm install` replaces the file and drops the bit, and it adds a setuid binary under the user's home directory.
- **Run with `--no-sandbox`.** Rejected. The renderers would run without a sandbox in an App that holds bank sign-in details.
- **Turn off the restriction system-wide with sysctl.** Rejected. It weakens every program on the machine, not only OctopusBeak.
