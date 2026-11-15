# Runner image for `act` (scripts/ci-local.mjs): mirrors the GitHub `ubuntu-24.04` runner
# that .github/workflows/pr-tests.yml uses. See docs/runbooks/local-ci.md.
FROM ubuntu:24.04

ARG NODE_VERSION
RUN test -n "$NODE_VERSION" || { echo "NODE_VERSION build arg is required" >&2; exit 1; }

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git git-lfs openssl sudo tar \
      build-essential python3 \
      xvfb dbus-x11 gnome-keyring libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1

# Non-root user: Electron/Chromium sandboxes behave like the CI runner only
# when not running as root. sudo is passwordless, as on the GitHub runner.
RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -m -u 1000 -s /bin/bash ci \
    && echo 'ci ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ci \
    && mkdir -p /work /home/ci/.npm /home/ci/.cache /opt/hostedtoolcache \
    && chown -R ci:ci /work /home/ci /opt/hostedtoolcache
# actions/setup-node caches Node here, as on the GitHub runner.
ENV RUNNER_TOOL_CACHE=/opt/hostedtoolcache AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache
RUN git config --system --add safe.directory '*'
USER ci
WORKDIR /work
