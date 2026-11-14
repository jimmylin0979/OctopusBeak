#!/usr/bin/env bash
set -euo pipefail

# Run inside dbus-run-session and Xvfb on the disposable Linux CI runner, like run-linux-ci-doctor.sh: the
# installed App starts with Electron's sandbox on, and its secret store needs an unlocked keyring.
# Usage: run-linux-ci-packaged-smoke.sh <installed resources/app directory>
export XDG_CURRENT_DESKTOP=GNOME
ci_keyring_password="$(openssl rand -hex 32)"
printf '%s' "$ci_keyring_password" | gnome-keyring-daemon --unlock --components=secrets
unset ci_keyring_password

node scripts/desktop-packaged-browser-smoke.mjs --app-root "${1:?usage: run-linux-ci-packaged-smoke.sh <app-root>}"
