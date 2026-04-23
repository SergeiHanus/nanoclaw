/**
 * Step: onecli — Install + configure the OneCLI gateway and CLI.
 *
 * Two modes:
 *   (default) run the OneCLI installer, configure api-host, write .env.
 *   --reuse   skip the installer; reuse the onecli instance already running
 *             on the host. Required for users who have other apps bound to
 *             an existing gateway, since re-running the installer rebinds
 *             the listener and breaks those consumers.
 *
 * Emits ONECLI_URL and polls /health so downstream steps (auth, service)
 * get a ready gateway.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../src/log.js';
import { emitStatus } from './status.js';

const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');

function childEnv(): NodeJS.ProcessEnv {
  const parts = [LOCAL_BIN];
  if (process.env.PATH) parts.push(process.env.PATH);
  return { ...process.env, PATH: parts.join(path.delimiter) };
}

function readContainerRuntime(): string {
  if (process.env.CONTAINER_RUNTIME) return process.env.CONTAINER_RUNTIME;
  try {
    const envFile = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envFile)) return 'docker';
    const content = fs.readFileSync(envFile, 'utf-8');
    const match = content.match(/^CONTAINER_RUNTIME=(.+)$/m);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    // .env absent or unreadable
  }
  return 'docker';
}

function podmanSocketPath(): string {
  // Try asking podman first (most reliable); fall back to the standard XDG path.
  try {
    const out = execSync('podman info --format "{{.Host.RemoteSocket.Path}}"', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out && out !== '<no value>') return out;
  } catch {
    // podman not answering — use the default path
  }
  return `/run/user/${os.userInfo().uid}/podman/podman.sock`;
}

// Temp dir holding the docker→podman shim; cleaned up after install.
let shimDir: string | null = null;

function createDockerShim(): string {
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-docker-shim-'));
  const shimPath = path.join(shimDir, 'docker');
  // For compose subcommands call podman-compose directly (not via `podman compose`)
  // so we can inject --podman-run-args for SELinux and strip --wait (unsupported).
  // pollHealth() already waits for the gateway, so --wait is unnecessary.
  fs.writeFileSync(
    shimPath,
    [
      '#!/usr/bin/env bash',
      'if [ "$1" = "compose" ]; then',
      '  shift',
      '  args=()',
      '  for arg in "$@"; do',
      '    [ "$arg" != "--wait" ] && args+=("$arg")',
      '  done',
      '  exec podman-compose --podman-run-args "--security-opt label=disable" "${args[@]}"',
      'fi',
      'exec podman "$@"',
      '',
    ].join('\n'),
  );
  fs.chmodSync(shimPath, 0o755);
  return shimDir;
}

export function cleanupDockerShim(): void {
  if (shimDir) {
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch { /* ignore */ }
    shimDir = null;
  }
}

function detectBindHost(): string {
  try {
    // Linux: resolve the source IP used to reach an external address.
    const out = execSync(
      "ip route get 1.1.1.1 | awk '/src/{for(i=1;i<=NF;i++) if($i==\"src\") print $(i+1); exit}'",
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(out)) return out;
  } catch { /* not Linux or ip not available */ }
  try {
    // macOS
    const out = execSync('ipconfig getifaddr en0 || ipconfig getifaddr en1', {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(out)) return out;
  } catch { /* not macOS or no active interface */ }
  return '0.0.0.0';
}

function installerEnv(): NodeJS.ProcessEnv {
  const base = childEnv();
  if (readContainerRuntime() !== 'podman' || !shimDir) return base;
  const sock = podmanSocketPath();
  const bindHost = detectBindHost();
  log.info('Podman: resolved OneCLI bind host', { bindHost });
  const parts = [shimDir];
  if (base.PATH) parts.push(base.PATH);
  return {
    ...base,
    PATH: parts.join(path.delimiter),
    DOCKER_HOST: `unix://${sock}`,
    ONECLI_BIND_HOST: bindHost,
  };
}

function onecliVersion(): string | null {
  try {
    return execFileSync('onecli', ['version'], {
      encoding: 'utf-8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Ask the installed onecli CLI for its configured api-host. Returns null if
 * onecli isn't on PATH, errors, or has no api-host configured.
 *
 * Tolerates both JSON output (onecli 1.3+) and older raw-text output.
 */
export function getOnecliApiHost(): string | null {
  try {
    const out = execFileSync('onecli', ['config', 'get', 'api-host'], {
      encoding: 'utf-8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    try {
      const parsed = JSON.parse(out) as { data?: unknown; value?: unknown };
      const val = parsed.data ?? parsed.value;
      if (typeof val === 'string' && val.trim()) return val.trim();
    } catch {
      // not JSON — fall through to URL extraction
    }
    return extractUrlFromOutput(out);
  } catch {
    return null;
  }
}

function extractUrlFromOutput(output: string): string | null {
  const match = output.match(/https?:\/\/[\w.\-]+(?::\d+)?/);
  return match ? match[0] : null;
}

function ensureShellProfilePath(): void {
  const home = os.homedir();
  const line = 'export PATH="$HOME/.local/bin:$PATH"';
  for (const profile of [path.join(home, '.bashrc'), path.join(home, '.zshrc')]) {
    try {
      const content = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf-8') : '';
      if (!content.includes('.local/bin')) {
        fs.appendFileSync(profile, `\n${line}\n`);
        log.info('Added ~/.local/bin to PATH in shell profile', { profile });
      }
    } catch (err) {
      log.warn('Could not update shell profile', { profile, err });
    }
  }
}

function writeEnvOnecliUrl(url: string): void {
  const envFile = path.join(process.cwd(), '.env');
  let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf-8') : '';
  if (/^ONECLI_URL=/m.test(content)) {
    content = content.replace(/^ONECLI_URL=.*$/m, `ONECLI_URL=${url}`);
  } else {
    content = content.trimEnd() + (content ? '\n' : '') + `ONECLI_URL=${url}\n`;
  }
  fs.writeFileSync(envFile, content);
}

// Last-known-good CLI release. Used only if BOTH the upstream installer
// and the redirect-based version probe fail. Bump deliberately when a
// new CLI release ships.
const ONECLI_CLI_FALLBACK_VERSION = '1.3.0';
const ONECLI_CLI_REPO = 'onecli/onecli-cli';

function installOnecli(): { stdout: string; ok: boolean } {
  let stdout = '';

  // Podman: create docker→podman shim once for all runInstall calls below.
  if (readContainerRuntime() === 'podman') createDockerShim();

  try {
    // Gateway install (docker-compose based, no rate-limit concerns).
    const gw = runInstall('curl -fsSL onecli.sh/install | sh');
    stdout += gw.stdout;
    if (!gw.ok) {
      log.error('OneCLI gateway install failed', { stderr: gw.stderr });
      return { stdout: stdout + (gw.stderr ?? ''), ok: false };
    }

    // CLI install. The upstream script calls the GitHub releases API
    // (api.github.com) to resolve the latest tag — which 403s anonymous
    // callers after 60 requests/hour per IP. Try upstream first; on failure
    // resolve the version ourselves (via HTTP redirect, which isn't
    // API-throttled) and download the release archive directly.
    const upstream = runInstall('curl -fsSL onecli.sh/cli/install | sh');
    stdout += upstream.stdout;
    if (upstream.ok) return { stdout, ok: true };

    log.warn('Upstream CLI installer failed — falling back to direct download', {
      stderr: upstream.stderr,
    });
    stdout += (upstream.stderr ?? '') + '\n';

    const fallback = installOnecliCliDirect();
    stdout += fallback.stdout;
    if (!fallback.ok) {
      log.error('OneCLI CLI install failed (both upstream and direct fallback)');
      return { stdout, ok: false };
    }
    return { stdout, ok: true };
  } finally {
    cleanupDockerShim();
  }
}

// Gateway pull + start can be slow on first run; CLI install is fast.
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

function runInstall(cmd: string): { stdout: string; stderr?: string; ok: boolean } {
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      env: installerEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: INSTALL_TIMEOUT_MS,
    });
    return { stdout, ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; signal?: string };
    if (e.signal === 'SIGTERM') {
      log.error('OneCLI installer timed out', { cmd, timeoutMs: INSTALL_TIMEOUT_MS });
      return { stdout: e.stdout ?? '', stderr: 'installer timed out after 5 minutes', ok: false };
    }
    return { stdout: e.stdout ?? '', stderr: e.stderr, ok: false };
  }
}

/**
 * Reinstate the OneCLI CLI install without hitting GitHub's rate-limited
 * releases API. Resolves the version via the HTTP redirect from
 * /releases/latest → /releases/tag/vX.Y.Z, then downloads the archive
 * directly. Falls back to ONECLI_CLI_FALLBACK_VERSION if the redirect
 * probe also fails.
 */
function installOnecliCliDirect(): { stdout: string; ok: boolean } {
  const lines: string[] = [];
  const append = (s: string): void => {
    lines.push(s);
  };

  const osName =
    process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  if (!osName) {
    append(`Unsupported platform: ${process.platform}`);
    return { stdout: lines.join('\n'), ok: false };
  }
  const arch =
    process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null;
  if (!arch) {
    append(`Unsupported arch: ${process.arch}`);
    return { stdout: lines.join('\n'), ok: false };
  }

  let version: string | null = null;
  try {
    const redirect = execSync(
      `curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/${ONECLI_CLI_REPO}/releases/latest`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    const m = redirect.match(/\/tag\/v?([^/]+)$/);
    if (m) version = m[1];
  } catch {
    // redirect probe failed — we'll pin the fallback
  }
  if (!version) {
    version = ONECLI_CLI_FALLBACK_VERSION;
    append(`Version probe failed; installing pinned fallback ${version}.`);
  } else {
    append(`Resolved onecli CLI ${version} via release redirect.`);
  }

  const archive = `onecli_${version}_${osName}_${arch}.tar.gz`;
  const url = `https://github.com/${ONECLI_CLI_REPO}/releases/download/v${version}/${archive}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-'));
  const archivePath = path.join(tmpDir, archive);

  try {
    append(`Downloading ${url}`);
    execSync(
      `curl -fsSL -o ${JSON.stringify(archivePath)} ${JSON.stringify(url)}`,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    execSync(`tar -xzf ${JSON.stringify(archivePath)} -C ${JSON.stringify(tmpDir)}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let installDir = '/usr/local/bin';
    try {
      fs.accessSync(installDir, fs.constants.W_OK);
    } catch {
      installDir = LOCAL_BIN;
      fs.mkdirSync(installDir, { recursive: true });
    }
    const binSrc = path.join(tmpDir, 'onecli');
    const binDest = path.join(installDir, 'onecli');
    fs.copyFileSync(binSrc, binDest);
    fs.chmodSync(binDest, 0o755);
    append(`onecli ${version} installed to ${binDest}.`);
    return { stdout: lines.join('\n'), ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    append(`Direct install failed: ${e.stderr ?? e.message ?? String(err)}`);
    return { stdout: lines.join('\n'), ok: false };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function pollHealth(url: string, timeoutMs: number): Promise<boolean> {
  // `/api/health` matches the path probe.sh uses — keep them aligned.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

export async function run(args: string[]): Promise<void> {
  const reuse = args.includes('--reuse');
  ensureShellProfilePath();

  if (reuse) {
    // Reuse-mode: don't touch the running gateway at all. Just verify it
    // exists, read its api-host, write ONECLI_URL to .env, and move on.
    const version = onecliVersion();
    if (!version) {
      emitStatus('ONECLI', {
        INSTALLED: false,
        STATUS: 'failed',
        ERROR: 'onecli_not_found_for_reuse',
        HINT: 'onecli not on PATH. Re-run setup and choose "install fresh".',
        LOG: 'logs/setup.log',
      });
      process.exit(1);
    }
    const url = getOnecliApiHost();
    if (!url) {
      emitStatus('ONECLI', {
        INSTALLED: true,
        STATUS: 'failed',
        ERROR: 'onecli_api_host_not_configured',
        HINT: 'Existing onecli has no api-host set. Run `onecli config set api-host <url>` or re-run setup with install-fresh.',
        LOG: 'logs/setup.log',
      });
      process.exit(1);
    }
    writeEnvOnecliUrl(url);
    log.info('Reusing existing OneCLI', { url });
    const healthy = await pollHealth(url, 5000);
    emitStatus('ONECLI', {
      INSTALLED: true,
      REUSED: true,
      ONECLI_URL: url,
      HEALTHY: healthy,
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
    return;
  }

  log.info('Installing OneCLI gateway and CLI');
  const res = installOnecli();
  if (!res.ok) {
    emitStatus('ONECLI', {
      INSTALLED: false,
      STATUS: 'failed',
      ERROR: 'install_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }
  if (!onecliVersion()) {
    emitStatus('ONECLI', {
      INSTALLED: false,
      STATUS: 'failed',
      ERROR: 'onecli_not_on_path_after_install',
      HINT: 'Open a new shell or run `export PATH="$HOME/.local/bin:$PATH"` and retry.',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  const url = extractUrlFromOutput(res.stdout);
  if (!url) {
    emitStatus('ONECLI', {
      INSTALLED: true,
      STATUS: 'failed',
      ERROR: 'could_not_resolve_api_host',
      HINT: 'Inspect logs/setup.log for the install output.',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  try {
    execFileSync('onecli', ['config', 'set', 'api-host', url], {
      stdio: 'ignore',
      env: childEnv(),
    });
  } catch (err) {
    log.warn('onecli config set api-host failed', { err });
  }

  writeEnvOnecliUrl(url);
  log.info('Wrote ONECLI_URL to .env', { url });

  const healthy = await pollHealth(url, 15000);

  emitStatus('ONECLI', {
    INSTALLED: true,
    ONECLI_URL: url,
    HEALTHY: healthy,
    // Install succeeded regardless — a failed health poll often just means
    // the endpoint is auth-gated or the gateway hasn't finished warming up.
    // The next step (auth) will surface a genuinely broken gateway via
    // `onecli secrets list`, so don't trigger rescue attempts from here.
    STATUS: 'success',
    ...(healthy
      ? {}
      : {
          HEALTH_HINT:
            'Health poll returned non-ok within 15s — likely auth-gated. Proceed to the auth step; it will surface a real outage.',
        }),
    LOG: 'logs/setup.log',
  });
}
