/**
 * Step: container — Build container image and verify with test run.
 * Replaces 03-setup-container.sh
 */
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';

import { log } from '../src/log.js';
import { getDefaultContainerImage } from '../src/install-slug.js';
import { commandExists, getPlatform } from './platform.js';
import { emitStatus } from './status.js';

const SUPPORTED_RUNTIMES = ['docker', 'podman'];

type RuntimeStatus = 'ok' | 'no-permission' | 'no-daemon' | 'other';

function runtimeStatus(runtime: string): RuntimeStatus {
  const res = spawnSync(runtime, ['info'], { encoding: 'utf-8' });
  if (res.status === 0) return 'ok';
  const err = `${res.stderr ?? ''}\n${res.stdout ?? ''}`;
  if (/permission denied/i.test(err)) return 'no-permission';
  if (/cannot connect|is the docker daemon running|no such file/i.test(err)) return 'no-daemon';
  return 'other';
}

function runtimeRunning(runtime: string): boolean {
  return runtimeStatus(runtime) === 'ok';
}

/**
 * Try to start Docker if it's installed but idle. Not called for Podman, which
 * is daemonless — `podman info` succeeds without any service to start.
 */
async function tryStartDocker(): Promise<RuntimeStatus> {
  const platform = getPlatform();
  log.info('Docker not running — attempting to start', { platform });

  try {
    if (platform === 'macos') {
      execSync('open -a Docker', { stdio: 'ignore' });
    } else if (platform === 'linux') {
      // Inherit stdio so sudo can prompt for a password if needed.
      execSync('sudo systemctl start docker', { stdio: 'inherit' });
    } else {
      return 'other';
    }
  } catch (err) {
    log.warn('Start command failed', { err });
    return 'other';
  }

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const s = runtimeStatus('docker');
    if (s === 'ok') {
      log.info('Docker is up');
      return 'ok';
    }
    if (s === 'no-permission') {
      log.info('Docker daemon is up but socket is not accessible (group membership)');
      return 'no-permission';
    }
  }
  log.warn('Docker did not become ready within 60s');
  return 'no-daemon';
}

function readContainerRuntime(): string {
  // Process env wins if already set (e.g. exported in shell before running setup).
  if (process.env.CONTAINER_RUNTIME) return process.env.CONTAINER_RUNTIME;
  // setup/index.ts doesn't load .env, so fall back to reading it directly.
  try {
    const envPath = path.join(process.cwd(), '.env');
    const content = fs.readFileSync(envPath, 'utf-8');
    const match = content.match(/^CONTAINER_RUNTIME=(.+)$/m);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    // .env absent or unreadable — use default
  }
  return 'docker';
}

function parseArgs(args: string[]): { runtime: string } {
  let runtime = readContainerRuntime();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runtime' && args[i + 1]) {
      runtime = args[i + 1];
      i++;
    }
  }
  return { runtime };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { runtime } = parseArgs(args);
  const image = getDefaultContainerImage(projectRoot);
  const logFile = path.join(projectRoot, 'logs', 'setup.log');

  if (!SUPPORTED_RUNTIMES.includes(runtime)) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'unknown_runtime',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  // Install runtime if missing
  if (!commandExists(runtime)) {
    const installerScript = runtime === 'podman'
      ? 'setup/install-podman.sh'
      : 'setup/install-docker.sh';
    log.info(`${runtime} not found — running ${installerScript}`);
    try {
      execSync(`bash ${installerScript}`, { cwd: projectRoot, stdio: 'inherit' });
    } catch (err) {
      log.warn(`${installerScript} failed`, { err });
    }
  }

  if (!commandExists(runtime)) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'runtime_not_available',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  {
    let status = runtimeStatus(runtime);

    if (status !== 'ok') {
      if (runtime === 'podman') {
        // Podman is daemonless — if `podman info` fails it's a real problem,
        // not a "daemon not started" situation.
        log.warn('Podman not accessible', { status });
      } else {
        status = await tryStartDocker();
      }
    }

    // Socket is unreachable due to group perms (Docker only) — re-exec under
    // `sg docker` so the child picks up docker as its primary group.
    if (status === 'no-permission' && runtime === 'docker' && getPlatform() === 'linux' && commandExists('sg')) {
      log.info('Re-executing container step under `sg docker`');
      const res = spawnSync(
        'sg',
        ['docker', '-c', 'pnpm exec tsx setup/index.ts --step container'],
        { cwd: projectRoot, stdio: 'inherit' },
      );
      process.exit(res.status ?? 1);
    }

    if (status !== 'ok') {
      const error =
        status === 'no-permission' ? 'docker_group_not_active' : 'runtime_not_available';
      emitStatus('SETUP_CONTAINER', {
        RUNTIME: runtime,
        IMAGE: image,
        BUILD_OK: false,
        TEST_OK: false,
        STATUS: 'failed',
        ERROR: error,
        LOG: 'logs/setup.log',
      });
      process.exit(2);
    }
  }

  const buildCmd = `${runtime} build`;
  const runCmd = runtime;

  // Build-args from .env. Only INSTALL_CJK_FONTS is passed through today.
  const buildArgs: string[] = [];
  try {
    const fs = await import('fs');
    const envPath = path.join(projectRoot, '.env');
    if (fs.existsSync(envPath)) {
      const match = fs.readFileSync(envPath, 'utf-8').match(/^INSTALL_CJK_FONTS=(.+)$/m);
      const val = match?.[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (val === 'true') buildArgs.push('--build-arg INSTALL_CJK_FONTS=true');
    }
  } catch {
    // .env is optional
  }

  // Podman on Linux with SELinux needs --security-opt label=disable on build too,
  // otherwise /bin/sh inside the build step hits "cannot apply additional memory
  // protection after relocation: Permission denied".
  const buildSecOpts = runtime === 'podman' && process.platform === 'linux'
    ? ['--security-opt', 'label=disable']
    : [];

  // Build — stdio inherit so the parent setup runner can tail output.
  let buildOk = false;
  log.info('Building container', { runtime, buildArgs });
  const buildRes = spawnSync(
    buildCmd.split(' ')[0],
    [
      ...buildCmd.split(' ').slice(1),
      ...buildSecOpts,
      ...buildArgs.flatMap((a) => a.split(' ')),
      '-t',
      image,
      '.',
    ],
    {
      cwd: path.join(projectRoot, 'container'),
      stdio: 'inherit',
    },
  );
  if (buildRes.status === 0) {
    buildOk = true;
    log.info('Container build succeeded');
  } else {
    log.error('Container build failed', { exitCode: buildRes.status });
  }

  // Test run
  let testOk = false;
  if (buildOk) {
    log.info('Testing container');
    try {
      // Podman on Linux with SELinux needs --security-opt label=disable
      const secOpts = runtime === 'podman' && process.platform === 'linux'
        ? '--security-opt label=disable'
        : '';
      const output = execSync(
        `echo '{}' | ${runCmd} run -i --rm ${secOpts} --entrypoint /bin/echo ${image} "Container OK"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      testOk = output.includes('Container OK');
      log.info('Container test result', { testOk });
    } catch {
      log.error('Container test failed');
    }
  }

  const status = buildOk && testOk ? 'success' : 'failed';

  emitStatus('SETUP_CONTAINER', {
    RUNTIME: runtime,
    IMAGE: image,
    BUILD_OK: buildOk,
    TEST_OK: testOk,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
