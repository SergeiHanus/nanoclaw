/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/**
 * The container runtime binary.
 * Resolution order: CONTAINER_RUNTIME env var → podman (if found) → docker.
 */
export const CONTAINER_RUNTIME_BIN =
  process.env.CONTAINER_RUNTIME || detectRuntime();

function detectRuntime(): string {
  for (const rt of ['podman', 'docker']) {
    try {
      execSync(`which ${rt}`, { stdio: 'pipe' });
      return rt;
    } catch {
      // not found, try next
    }
  }
  return 'docker'; // fallback — ensureContainerRuntimeRunning() will surface the error
}

export const IS_PODMAN = CONTAINER_RUNTIME_BIN === 'podman';

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = IS_PODMAN
  ? 'host.containers.internal'
  : 'host.docker.internal';

/**
 * Whether SELinux is currently in enforcing mode.
 * When true, volume mounts require the :z relabeling option so the container
 * process can access host-owned files under an SELinux-confined domain.
 */
export const SELINUX_ENFORCING = detectSELinux();

function detectSELinux(): boolean {
  try {
    return fs.readFileSync('/sys/fs/selinux/enforce', 'utf-8').trim() === '1';
  } catch {
    return false;
  }
}

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the container bridge IP instead of 0.0.0.0.
  // Docker uses docker0; rootful Podman uses podman0 or cni-podman0.
  // Rootless Podman has no visible bridge — falls through to 0.0.0.0.
  const ifaces = os.networkInterfaces();
  const bridge =
    ifaces['docker0'] ?? ifaces['podman0'] ?? ifaces['cni-podman0'];
  if (bridge) {
    const ipv4 = bridge.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/**
 * CLI args to disable SELinux label confinement for a container.
 * Required on SELinux-enforcing systems with rootless Podman so the container
 * process can apply memory protections (execmem) when loading libc.
 */
export function selinuxRunArgs(): string[] {
  if (SELINUX_ENFORCING && IS_PODMAN) {
    return ['--security-opt', 'label=disable'];
  }
  return [];
}

/**
 * For rootless Podman, map the host user's UID/GID into the container
 * so bind-mounted files are accessible. Without this, uid 1000 inside the
 * container maps to a subuid on the host instead of the actual host uid.
 */
export function rootlessPodmanArgs(): string[] {
  const hostUid = process.getuid?.();
  if (IS_PODMAN && hostUid != null && hostUid !== 0) {
    return ['--userns=keep-id'];
  }
  return [];
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux the gateway hostname isn't injected automatically — add it explicitly.
  // Podman 4+ does inject host.containers.internal, but we add it anyway for older versions.
  if (os.platform() === 'linux') {
    return [`--add-host=${CONTAINER_HOST_GATEWAY}:host-gateway`];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  // Device nodes (e.g. /dev/null) cannot be relabeled — skip :z for them.
  const selinux = SELINUX_ENFORCING && !hostPath.startsWith('/dev/');
  const opts = selinux ? 'ro,z' : 'ro';
  return ['-v', `${hostPath}:${containerPath}:${opts}`];
}

/** Returns CLI args for a read-write bind mount. */
export function rwMountArgs(hostPath: string, containerPath: string): string[] {
  // Device nodes (e.g. /dev/null) cannot be relabeled — skip :z for them.
  const selinux = SELINUX_ENFORCING && !hostPath.startsWith('/dev/');
  if (selinux) {
    return ['-v', `${hostPath}:${containerPath}:z`];
  }
  return ['-v', `${hostPath}:${containerPath}`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      `║  1. Ensure ${CONTAINER_RUNTIME_BIN} is installed and running              ║`,
    );
    console.error(
      `║  2. Run: ${CONTAINER_RUNTIME_BIN} info                                    ║`,
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
