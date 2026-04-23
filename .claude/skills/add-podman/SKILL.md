---
name: add-podman
description: Switch from Docker to Podman as the container runtime. Use when the user wants to run NanoClaw with Podman instead of Docker, or when Docker is not available. Triggers on "use podman", "switch to podman", "add podman", or "podman runtime".
---

# Add Podman Runtime

Switches NanoClaw's container runtime from Docker to Podman. Works on Linux (rootless or rootful) and macOS. On Linux with SELinux, the required `--security-opt label=disable` and `--userns=keep-id` flags are applied automatically.

**What this changes:**
- Adds `CONTAINER_RUNTIME=podman` to `.env`
- `src/container-runtime.ts` — runtime abstraction that reads the env var and injects Podman-specific flags
- `src/container-runner.ts` — imports from the new runtime abstraction
- `container/build.sh` — reads `CONTAINER_RUNTIME` from `.env` and adds `--security-opt label=disable` on Linux builds

**What stays the same:**
- All mount logic, session DB protocol, OneCLI credential injection
- All exported interfaces
- Docker remains the default for users who don't run this skill

## Prerequisites

Verify Podman is installed:

```bash
podman --version && echo "Podman ready" || echo "Install Podman first"
```

If not installed:
- **Linux:** `sudo dnf install podman` (Fedora/RHEL) or `sudo apt install podman` (Debian/Ubuntu)
- **macOS:** `brew install podman && podman machine init && podman machine start`

## Phase 1: Pre-flight

### Check if already configured

```bash
grep 'CONTAINER_RUNTIME' .env 2>/dev/null || echo "not set"
```

If it already shows `CONTAINER_RUNTIME=podman`, skip to Phase 3.

## Phase 2: Merge the skill branch

### Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing, add it:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge

```bash
git fetch upstream skill/podman
git merge upstream/skill/podman
```

This merges in:
- `src/container-runtime.ts` — Podman-aware runtime abstraction (`CONTAINER_RUNTIME_BIN`, `runtimeExtraArgs`, `hostGatewayArgs`)
- `src/container-runner.ts` — imports from the runtime abstraction
- `container/build.sh` — reads `CONTAINER_RUNTIME` from `.env`, adds SELinux flags on Linux

If the merge reports conflicts, read the conflicted files and resolve by keeping the intent of both sides.

### Validate

```bash
pnpm run build
```

Build must be clean before proceeding.

## Phase 3: Configure environment

```bash
grep -q '^CONTAINER_RUNTIME=' .env 2>/dev/null \
  && sed -i 's/^CONTAINER_RUNTIME=.*/CONTAINER_RUNTIME=podman/' .env \
  || echo 'CONTAINER_RUNTIME=podman' >> .env
```

Verify:

```bash
grep CONTAINER_RUNTIME .env
```

## Phase 4: Build the container image

```bash
./container/build.sh
```

The build script reads `CONTAINER_RUNTIME` from `.env` and automatically adds `--security-opt label=disable` on Linux with SELinux.

## Phase 5: Restart NanoClaw

```bash
# Linux (systemd)
systemctl --user restart nanoclaw

# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 6: Verify

### Runtime is reachable

```bash
podman info > /dev/null && echo "Podman OK"
```

### Container spawns correctly

Send a message to the agent and confirm it replies. Check logs if needed:

```bash
tail -f logs/nanoclaw.log
```

Look for `Spawning container` lines — they should show `nanoclaw-v2-` prefixed container names.

## Troubleshooting

**`podman info` fails on Linux:**
```bash
# Rootless Podman needs the socket
systemctl --user start podman.socket
```

**SELinux permission denied during build:**

The build script adds `--security-opt label=disable` automatically when `CONTAINER_RUNTIME=podman` and the host is Linux. If you see a relabeling error, verify `.env` is set correctly and re-run `./container/build.sh`.

**Container can't write to mounted directories (rootless Podman):**

`--userns=keep-id` is applied automatically on Linux to map the host UID into the container. If you see permission errors on mounts, verify the host directory is owned by your user:

```bash
ls -la data/v2-sessions/
```

**macOS — Podman machine not running:**

```bash
podman machine start
podman info
```

**OneCLI credential proxy not reachable from container:**

On Linux, `host.docker.internal` is added automatically via `--add-host`. Verify the proxy is running:

```bash
curl -s http://host.docker.internal:3001/health
```
