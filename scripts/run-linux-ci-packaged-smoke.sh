#!/usr/bin/env bash
set -euo pipefail

# Run inside dbus-run-session and Xvfb on the disposable Linux CI runner, like run-linux-ci-doctor.sh: the
# installed App starts with Electron's sandbox on, and its secret store needs an unlocked keyring.
# Usage: run-linux-ci-packaged-smoke.sh <installed resources/app directory>
export XDG_CURRENT_DESKTOP=GNOME
ci_keyring_password="$(openssl rand -hex 32)"
printf '%s' "$ci_keyring_password" | gnome-keyring-daemon --unlock --components=secrets
unset ci_keyring_password

OCTOPUSBEAK_SMOKE_APP_ENV="DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_CURRENT_DESKTOP XDG_RUNTIME_DIR" \
  OCTOPUSBEAK_SMOKE_APP_ARGS="--disable-gpu" OCTOPUSBEAK_SMOKE_SHOW_APP_STDERR=1 \
  node scripts/desktop-packaged-browser-smoke.mjs --app-root "${1:?usage: run-linux-ci-packaged-smoke.sh <app-root>}"
