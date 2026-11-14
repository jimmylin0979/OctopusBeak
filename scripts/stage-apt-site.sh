#!/usr/bin/env bash
# ADR 0141: every Pages deploy carries the apt repository of the newest release, because Pages serves only
# what the deploy uploads. Usage: stage-apt-site.sh <site-directory>. A repository with no Linux release yet
# is a no-op; any other failure stops the deploy so apt is never silently dropped from the live site.
set -euo pipefail

site="${1:?usage: stage-apt-site.sh <site-directory>}"

if ! assets="$(gh release view --json assets --jq '.assets[].name' 2>&1)"; then
  if [[ "$assets" == *"release not found"* ]]; then
    echo "No release yet; the site ships without an apt repository."
    exit 0
  fi
  echo "Could not read the newest release: $assets" >&2
  exit 1
fi

if ! grep -qx 'apt-repo.tar' <<< "$assets"; then
  echo "The newest release has no apt-repo.tar; the site ships without an apt repository."
  exit 0
fi

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
gh release download --pattern apt-repo.tar --dir "$scratch"
mkdir -p "$site/apt"
tar -xf "$scratch/apt-repo.tar" -C "$site/apt"
echo "Staged the apt repository from the newest release into $site/apt."
