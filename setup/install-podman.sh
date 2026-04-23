#!/usr/bin/env bash
# Setup helper: install-podman — bundles Podman install into one idempotent
# script so /setup can run it without needing `curl | sh` in the allowlist.
set -euo pipefail

echo "=== NANOCLAW SETUP: INSTALL_PODMAN ==="

if command -v podman >/dev/null 2>&1; then
  echo "STATUS: already-installed"
  echo "PODMAN_VERSION: $(podman --version 2>/dev/null || echo unknown)"
  echo "=== END ==="
  exit 0
fi

case "$(uname -s)" in
  Darwin)
    echo "STEP: brew-install-podman"
    if ! command -v brew >/dev/null 2>&1; then
      echo "STATUS: failed"
      echo "ERROR: Homebrew not installed. Install brew first (https://brew.sh) then re-run."
      echo "=== END ==="
      exit 1
    fi
    brew install podman
    ;;
  Linux)
    if command -v apt-get >/dev/null 2>&1; then
      echo "STEP: apt-install-podman"
      sudo apt-get update -qq
      sudo apt-get install -y podman
    elif command -v dnf >/dev/null 2>&1; then
      echo "STEP: dnf-install-podman"
      sudo dnf install -y podman
    elif command -v pacman >/dev/null 2>&1; then
      echo "STEP: pacman-install-podman"
      sudo pacman -S --noconfirm podman
    else
      echo "STATUS: failed"
      echo "ERROR: Cannot determine package manager. Install Podman manually: https://podman.io/getting-started/installation"
      echo "=== END ==="
      exit 1
    fi
    ;;
  *)
    echo "STATUS: failed"
    echo "ERROR: Unsupported platform: $(uname -s)"
    echo "=== END ==="
    exit 1
    ;;
esac

if ! command -v podman >/dev/null 2>&1; then
  echo "STATUS: failed"
  echo "ERROR: podman not found on PATH after install"
  echo "=== END ==="
  exit 1
fi

echo "STATUS: installed"
echo "PODMAN_VERSION: $(podman --version 2>/dev/null || echo unknown)"
echo "=== END ==="
