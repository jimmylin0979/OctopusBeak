# Ubuntu updates notify only, for now

Status: accepted (interim — to be replaced by an installing updater)

Amends [ADR 0083](0083-automatic-updates-from-github-releases.md) for Ubuntu.

ADR 0083 downloads and verifies the release ZIP, then hands it to Squirrel.Mac, which installs it when the App restarts. Electron has no updater for Linux. A `.deb` can only be installed with root, so the App cannot replace itself the way it does on macOS.

**On Ubuntu, the App checks `update-feed-linux-x64.json` the same way it checks the macOS feed, and when a newer release exists it notifies the person and links to the release page. The person downloads the `.deb` and installs it with `sudo apt install ./<file>.deb`. The App downloads and installs nothing itself.** The feed has the same schema, the same strictly-newer rule, and the same privacy terms as ADR 0083.

**This is a temporary state, not the intended end state.** It ships Ubuntu support without an updater that raises privileges, and it postpones that design until Linux users give feedback. A later ADR will replace this one with an updater that installs the update, either a verified download installed through `pkexec`, or a signed apt repository that `apt upgrade` updates. Until then, an Ubuntu App stays on an old version until the person installs the new one, and a fixed source keeps failing on that App, the risk ADR 0083 was written to remove.

## Considered options

- **Download, verify, and install through `pkexec apt install`.** Deferred. It needs privilege escalation, recovery from a failed install, and a restart flow designed for Linux.
- **A signed apt repository on GitHub Pages.** Deferred. It needs a long-lived signing key and someone to maintain the repository.
- **AppImage with self-replacement.** Rejected by the packaging decision: an AppImage path changes from run to run, so the AppArmor profile of [ADR 0138](0138-electron-sandbox-on-ubuntu-through-an-apparmor-profile.md) cannot cover it.
