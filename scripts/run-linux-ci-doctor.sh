#!/usr/bin/env bash
set -euo pipefail

# Run inside dbus-run-session and Xvfb on the disposable Linux CI runner, the
# way scripts/run-linux-ci-tests.sh does: a desktop session unlocks the keyring
# at sign-in, and the runner has no sign-in.
export XDG_CURRENT_DESKTOP=GNOME
ci_keyring_password="$(openssl rand -hex 32)"
printf '%s' "$ci_keyring_password" | gnome-keyring-daemon --unlock --components=secrets
unset ci_keyring_password

npm run doctor
