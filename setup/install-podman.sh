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

echo "STEP: ensure-pipx"
if ! command -v pipx >/dev/null 2>&1; then
  case "$(uname -s)" in
    Darwin)
      brew install pipx
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get install -y pipx
      elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y pipx
      elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --noconfirm python-pipx
      else
        echo "WARNING: cannot install pipx — unknown package manager. Install pipx manually then run: pipx install podman-compose"
      fi
      ;;
  esac
fi

echo "STEP: pipx-install-podman-compose"
if command -v pipx >/dev/null 2>&1; then
  pipx install podman-compose
else
  echo "WARNING: pipx not found — skipping podman-compose install. Install pipx and run: pipx install podman-compose"
fi

if ! command -v podman >/dev/null 2>&1; then
  echo "STATUS: failed"
  echo "ERROR: podman not found on PATH after install"
  echo "=== END ==="
  exit 1
fi

echo "STEP: configure-registries"
REGISTRIES_CONF="${XDG_CONFIG_HOME:-$HOME/.config}/containers/registries.conf"
mkdir -p "$(dirname "$REGISTRIES_CONF")"
if [ ! -f "$REGISTRIES_CONF" ]; then
  printf 'unqualified-search-registries = ["docker.io"]\n' > "$REGISTRIES_CONF"
  echo "REGISTRIES: created"
elif ! grep -q 'unqualified-search-registries' "$REGISTRIES_CONF"; then
  # Prepend the line so it takes effect before any other content.
  { printf 'unqualified-search-registries = ["docker.io"]\n\n'; cat "$REGISTRIES_CONF"; } > "$REGISTRIES_CONF.tmp"
  mv "$REGISTRIES_CONF.tmp" "$REGISTRIES_CONF"
  echo "REGISTRIES: prepended"
elif ! grep -q 'docker\.io' "$REGISTRIES_CONF"; then
  # Line exists but docker.io is missing — insert it into the array with sed.
  sed -i 's/\(unqualified-search-registries\s*=\s*\[\)/\1"docker.io", /' "$REGISTRIES_CONF"
  echo "REGISTRIES: updated"
else
  echo "REGISTRIES: already-configured"
fi

echo "STATUS: installed"
echo "PODMAN_VERSION: $(podman --version 2>/dev/null || echo unknown)"
echo "=== END ==="
