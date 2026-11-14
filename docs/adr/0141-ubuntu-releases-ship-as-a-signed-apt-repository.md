# Ubuntu releases ship as a signed apt repository

Status: accepted

Supersedes [ADR 0139](0139-ubuntu-updates-notify-only-for-now.md). Builds on [ADR 0138](0138-electron-sandbox-on-ubuntu-through-an-apparmor-profile.md), [ADR 0083](0083-automatic-updates-from-github-releases.md), and [ADR 0003](0003-manual-immutable-electron-releases.md).

ADR 0139 left two ways to update an Ubuntu App: install through `pkexec`, or a signed apt repository. The App holds bank sign-in details, so it should never raise its own privileges to replace itself.

**An Ubuntu release is a `.deb` published in a signed apt repository on GitHub Pages. `apt upgrade` installs the update; the App installs nothing and downloads nothing.**

- **Target.** amd64 only, one suite named `stable`, one `.deb` that serves Ubuntu 24.04 and 26.04. `Depends:` lists only libraries both releases share. arm64 needs its own ADR.
- **Where files live.** Apt resolves `Filename:` relative to the repository, so the `.deb` is served from Pages with the metadata. Pages holds only the latest `.deb`, because a Pages site is limited to about 1 GB; older `.deb` files stay on their GitHub Releases. `apt` can therefore install only the newest version. No host we operate sits in the path, so ADR 0083's privacy terms hold.
- **One source of truth.** The release workflow builds the `.deb`, signs `Release` and `InRelease`, and attaches the complete `apt/` tree to the release as `apt-repo.tar`. Every Pages deploy, from `pages.yml` or from the release workflow, first unpacks the newest release's `apt-repo.tar` into `site/apt/`. A site edit therefore never removes the repository. Only the release job holds a signing key.
- **Signing.** A new offline primary key certifies a signing subkey that the release job holds as a secret. If the subkey leaks, the primary key revokes it and certifies a new one; the keyring that users installed keeps working because it trusts the primary key. The primary key is created and kept by the maintainer, never by CI.
- **Publish order.** The workflow signs the tree and deploys Pages, confirms `apt update` sees the new version, and only then turns the Draft Release into a Published one. The update feed is a release asset, so it appears only after the apt repository can serve the version it announces.
- **Bootstrap.** The README gives the keyring and deb822 source commands, then `sudo apt install octopusbeak`. The `.deb` also writes the same source file and keyring in `postinst` (as Chrome does), so every installed machine is apt-managed however it was installed. `purge` removes them. A change of primary key ships in a new `.deb`.
- **Sandbox.** `postinst` installs the AppArmor profile for the install path (ADR 0138); `postrm` removes it.
- **The App on Ubuntu.** A packaged Ubuntu App reads `update-feed-linux-x64.json` under ADR 0083's schema, strictly-newer rule, and privacy terms, and downloads nothing. When a newer release exists, the sidebar and one notification say "新版 X 可用" and show `sudo apt update && sudo apt upgrade` with a copy button. Source checkouts never check.

## Considered options

- **Install through `pkexec apt install`.** Rejected. It needs privilege escalation inside an App that holds bank sign-in details, plus recovery from a failed install.
- **Signing key as a plain CI secret.** Rejected. A compromised workflow would sign malicious updates for every Ubuntu user.
- **Offline key and hand-signed releases.** Rejected. It blocks release whenever the maintainer is away.
- **Keep several `.deb` versions on Pages.** Rejected. Two versions exceed the Pages size limit.
- **Commit the apt tree to git.** Rejected. Each `.deb` is hundreds of megabytes and would stay in history for good.
- **A CDN or host we run.** Rejected. It breaks ADR 0083's promise that update requests reach only GitHub.
- **No update check in the App.** Rejected by the maintainer in favor of a notice, even though Ubuntu's Software Updater also notifies.
