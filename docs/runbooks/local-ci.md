# Run PR Tests locally (act + Docker)

Runs `.github/workflows/pr-tests.yml` itself with [`act`](https://nektosact.com)
in a Docker image that mirrors the `ubuntu-24.04` runner, so failures show up
before a PR is pushed. Manual only; no git hook.

```bash
npm run ci:local                    # typecheck + every test lane
npm run ci:local -- typecheck unit-1  # selected jobs
```

Jobs: `typecheck`, `unit-1`..`unit-4`, `browser`, `electron`.

## Requirements

- `act` (standalone or `gh extension install nektos/gh-act`) and a running Docker daemon.
- Docker Desktop VM memory of about 6 GB or more (Settings > Resources). At
  3.7 GB the unit lanes are OOM-killed.

## What `scripts/ci-local.mjs` sets up

- Builds `scripts/ci-local/Dockerfile` as the runner image; the Node version is read from `pr-tests.yml`.
- Runs jobs one at a time; act starts every matrix entry in parallel and exhausts memory.
- Limits the container to 4 CPUs like GitHub's runner, and `--shm-size=2g` so Chromium does not crash.
- `seccomp=unconfined` lets Chromium and Electron create their sandbox.
- In a git worktree, mounts the main repository's `.git` read-only at the same path so git and the LFS attribute check work.
- Uses Docker Desktop's socket when `/var/run/docker.sock` is missing, and an empty `DOCKER_CONFIG` for the image build so a credential helper cannot prompt.

## Differences from GitHub CI

- act's artifact server does not understand `upload-artifact` v7, so the script
  runs a temporary copy of the workflow without the "Upload lane reports" step.
  The repository workflow is unchanged.
- The `Tests` job that combines lane reports is not run. Each lane's result is
  its own pass or fail.
- Lanes can be slower than on GitHub, and `act` re-runs `npm ci` per job.
