import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import yargs from 'yargs';

import { log } from '../log.js';
import { bundleEntry } from '../utils/esbuild.js';
import { resolveDevEnv } from '../dev/env.js';
import {
  resolveFunctionsFromConfig,
  type PlannedFunction,
} from '../dev/functions.js';
import { resolveWatchInputs } from '../dev/inputs.js';
import { branchIdResolve } from '../utils/enrichers.js';
import type { CommonProps } from '../types.js';

type DevProps = CommonProps & {
  source?: string;
  port?: number;
  projectId?: string;
  branch?: string;
  id?: string;
};

export const command = 'dev';
export const describe = 'Run Neon Functions locally with a dev server';

export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 dev [--source <path>] [options]')
    .example(
      '$0 dev --source ./functions/hello.ts',
      'Serve one function on a free port with hot reload',
    )
    .example(
      '$0 dev',
      'Serve every function declared in neon.ts (one dev server each)',
    )
    .example(
      '$0 dev --source ./functions/hello.ts --port 3000',
      'Serve one function on an explicit port (fails if the port is taken)',
    )
    .options({
      source: {
        describe:
          'Path to a single function entry module. Omit to serve every ' +
          'function declared in neon.ts.',
        type: 'string',
      },
      port: {
        describe:
          'Port to listen on (single-function mode only, with --source). ' +
          'Fails if taken. Without it (and without a PORT env var) a free ' +
          'port is chosen automatically.',
        type: 'number',
      },
    })
    .strict();

export const handler = async (props: DevProps): Promise<void> => {
  if (props.source !== undefined) {
    await runSingleSource(props);
    return;
  }

  // No --source: --port has no single target to bind, so reject it explicitly
  // rather than silently ignoring it.
  if (props.port !== undefined) {
    throw new Error(
      '--port can only be used with --source. To set ports for the functions ' +
        'in neon.ts, give each one a `dev.port` in its config.',
    );
  }

  await runFromConfig(props);
};

/** Single-function mode: serve exactly the `--source` path (legacy behavior). */
const runSingleSource = async (props: DevProps): Promise<void> => {
  const source = resolve(process.cwd(), props.source as string);
  if (!existsSync(source)) {
    throw new Error(`Source file not found: ${source}`);
  }

  const branchId = await resolveBranchId(props);
  const neonEnv = await resolveDevEnv({
    cwd: process.cwd(),
    ...(props.projectId ? { projectId: props.projectId } : {}),
    ...(branchId ? { branchId } : {}),
    ...(props.apiKey ? { apiKey: props.apiKey } : {}),
  });

  const unit: ServedUnit = {
    slug: null,
    source,
    bundleDir: join(process.cwd(), 'node_modules', '.neon-dev'),
    childEnv: buildChildEnv(neonEnv, portFromProps(props.port)),
    label: null,
  };

  await runSupervisor([unit]);
};

/**
 * Multi-function mode: serve every function declared in neon.ts. Requires a neon.ts
 * (there is no single source to fall back on), one dev server per function.
 */
const runFromConfig = async (props: DevProps): Promise<void> => {
  const branchId = await resolveBranchId(props);
  const functions = await resolveFunctionsFromConfig(process.cwd());

  if (functions === null) {
    throw new Error(
      'No --source given and no neon.ts found. Pass --source <path> to run a ' +
        'single function, or add a neon.ts that declares functions under ' +
        '`preview.functions`.',
    );
  }
  if (functions.length === 0) {
    throw new Error(
      'neon.ts has no functions to serve. Add at least one under ' +
        '`preview.functions`, or pass --source <path>.',
    );
  }

  const neonEnv = await resolveDevEnv({
    cwd: process.cwd(),
    ...(props.projectId ? { projectId: props.projectId } : {}),
    ...(branchId ? { branchId } : {}),
    ...(props.apiKey ? { apiKey: props.apiKey } : {}),
  });

  // Give each search-mode (no dev.port, non-portless) function a distinct search base so
  // they don't all start probing at the same port. The runtime still walks upward from its
  // base, so an occupied base self-resolves; the offset just makes startup deterministic.
  let searchOffset = 0;
  const units = functions.map((fn) => {
    const base = DEFAULT_PORT_BASE + searchOffset;
    if (!fn.portless && fn.port === undefined) searchOffset += 1;
    return plannedToUnit(fn, neonEnv, base);
  });
  await runSupervisor(units);
};

/**
 * Resolve the selected branch id from props, if any. Best-effort: a failure here only
 * means env injection is skipped, so it never throws.
 */
const resolveBranchId = async (
  props: DevProps,
): Promise<string | undefined> => {
  if (!props.apiClient || !props.projectId) return undefined;
  const branch = props.branch ?? props.id;
  if (!branch) return undefined;
  try {
    return await branchIdResolve({
      branch,
      apiClient: props.apiClient,
      projectId: props.projectId,
    });
  } catch (err) {
    log.debug(
      'dev: could not resolve branch id: %s',
      err instanceof Error ? err.message : String(err),
    );
    return undefined;
  }
};

const DEFAULT_PORT_BASE = 8787;

type PortSpec =
  // Bind exactly this port (fail if taken) via NEON_DEV_PORT.
  | { mode: 'explicit'; port: number }
  // Search upward from `from` via NEON_DEV_PORT_BASE.
  | { mode: 'search'; from: number }
  // Set no port env at all — let an injected PORT (portless) drive the runtime.
  | { mode: 'inherit' };

const portFromProps = (port: number | undefined): PortSpec => {
  if (port !== undefined) return { mode: 'explicit', port };
  if (process.env.PORT !== undefined && process.env.PORT !== '') {
    return { mode: 'explicit', port: Number(process.env.PORT) };
  }
  return { mode: 'search', from: DEFAULT_PORT_BASE };
};

/**
 * Translate a {@link PlannedFunction} into a {@link ServedUnit}. Port rules:
 *   - portless: portless assigns the port and injects PORT, which the runtime honors — so
 *     we set no port env (`inherit`) and `dev.port` is ignored. Wrapped with
 *     `portless <slug>` for a stable `slug.localhost` URL.
 *   - explicit `dev.port`: bind exactly, fail if taken.
 *   - no `dev.port`: search for a free port (base coordinated by the caller).
 * Per-function neon.ts env layers over the shared branch env.
 */
const plannedToUnit = (
  fn: PlannedFunction,
  branchEnv: Record<string, string>,
  searchBase: number,
): ServedUnit => {
  const port: PortSpec = fn.portless
    ? { mode: 'inherit' }
    : fn.port !== undefined
      ? { mode: 'explicit', port: fn.port }
      : { mode: 'search', from: searchBase };
  const childEnv = buildChildEnv({ ...branchEnv, ...fn.env }, port);
  return {
    slug: fn.slug,
    source: fn.source,
    bundleDir: join(process.cwd(), 'node_modules', '.neon-dev', fn.slug),
    childEnv,
    label: fn.slug,
    ...(fn.portless ? { portless: { slug: fn.slug } } : {}),
  };
};

/**
 * Build a child's env. Neon vars layer over the inherited environment (so the branch's
 * DATABASE_URL wins over a stale inherited value); a function that loads its own `.env`
 * at runtime still overrides them. The port spec is encoded for the runtime via
 * NEON_DEV_PORT (explicit) or NEON_DEV_PORT_BASE (search).
 */
const buildChildEnv = (
  neonEnv: Record<string, string>,
  port: PortSpec,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...neonEnv };
  delete env.NEON_DEV_PORT;
  delete env.NEON_DEV_PORT_BASE;
  if (port.mode === 'explicit') {
    env.NEON_DEV_PORT = String(port.port);
  } else if (port.mode === 'search') {
    env.NEON_DEV_PORT_BASE = String(port.from);
  }
  // 'inherit': set neither, so an injected PORT (portless) drives the runtime.
  return env;
};

/**
 * One function being served locally. `slug`/`label` are null in single-source mode
 * (one unnamed server). `portless`, when set, wraps the child with `portless run`.
 */
type ServedUnit = {
  slug: string | null;
  source: string;
  bundleDir: string;
  childEnv: NodeJS.ProcessEnv;
  label: string | null;
  portless?: { slug: string };
};

type RunningUnit = {
  unit: ServedUnit;
  child: ChildProcess | null;
  boundPort: number | null;
  everReady: boolean;
  restartTimer: NodeJS.Timeout | null;
  watcher: Watcher | null;
  status: 'starting' | 'ready' | 'error';
};

const READY_PATTERN = /neon-dev:ready (\d+)/;

/**
 * Supervise one or more {@link ServedUnit}s: bundle + start each in its own child, watch
 * its inputs for hot reload, and tear everything down cleanly on shutdown. Units are
 * independent — one crashing or failing to start does not stop the others (it is shown
 * as errored and recovered on the next edit). A single SIGINT/SIGTERM shuts all of them
 * down, tree-killing each child so no descendant (e.g. a portless-wrapped runtime) is
 * orphaned.
 */
const runSupervisor = async (units: ServedUnit[]): Promise<void> => {
  if (hasPortlessUnit(units)) {
    assertPortlessAvailable();
  }

  const runtimePath = resolveRuntimePath();
  let shuttingDown = false;

  const running: RunningUnit[] = units.map((unit) => ({
    unit,
    child: null,
    boundPort: null,
    everReady: false,
    restartTimer: null,
    watcher: null,
    status: 'starting',
  }));

  const bundleAndStart = async (r: RunningUnit): Promise<void> => {
    let bundlePath: string;
    try {
      bundlePath = await writeBundle(r.unit.source, r.unit.bundleDir);
    } catch (err) {
      r.status = 'error';
      logUnit(
        r.unit,
        chalk.red('bundle failed: ') +
          (err instanceof Error ? err.message : String(err)),
      );
      return;
    }

    if (r.watcher) await r.watcher.sync();

    const next = spawnChild(r.unit, runtimePath, bundlePath);
    r.child = next;

    const ready = waitForReady(next);
    pipeChildOutput(next, r.unit.label);

    next.on('exit', (code, signal) => {
      if (shuttingDown || r.child !== next) return;
      if (signal) {
        log.debug(
          'runtime for %s exited via %s',
          r.unit.slug ?? '(source)',
          signal,
        );
        return;
      }
      if (code && code !== 0 && r.everReady) {
        r.status = 'error';
        logUnit(
          r.unit,
          chalk.red(`exited with code ${code} (waiting for a change)`),
        );
      }
    });

    const port = await ready;
    if (port !== null) {
      r.boundPort = port;
      r.everReady = true;
      r.status = 'ready';
    } else {
      r.status = 'error';
    }
  };

  const restart = (r: RunningUnit): void => {
    if (shuttingDown) return;
    if (r.restartTimer) clearTimeout(r.restartTimer);
    r.restartTimer = setTimeout(() => {
      void (async () => {
        logUnit(r.unit, chalk.dim('change detected, restarting…'));
        if (r.child) await killTree(r.child);
        if (shuttingDown) return;
        await bundleAndStart(r);
        if (r.status === 'ready') {
          logUnit(r.unit, chalk.green('ready') + ` ${urlFor(r.boundPort)}`);
        }
      })();
    }, 150);
  };

  // Create each watcher before its first bundle so bundleAndStart can sync the
  // watch set on every run (including the initial one).
  for (const r of running) {
    r.watcher = await startWatcher(r.unit.source, () => {
      restart(r);
    });
  }

  // Start every unit. They are independent: keep going if one fails.
  await Promise.all(running.map((r) => bundleAndStart(r)));

  if (running.every((r) => r.status === 'error')) {
    await Promise.all(running.map((r) => r.watcher?.close()));
    await Promise.all(
      running.map((r) => (r.child ? killTree(r.child) : undefined)),
    );
    for (const r of running)
      rmSync(r.unit.bundleDir, { recursive: true, force: true });
    throw new Error('No function started. See the output above for details.');
  }

  printBanner(running);

  await new Promise<void>((resolveRun) => {
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      void (async () => {
        for (const r of running) {
          if (r.restartTimer) clearTimeout(r.restartTimer);
        }
        await Promise.all(running.map((r) => r.watcher?.close()));
        await Promise.all(
          running.map((r) => (r.child ? killTree(r.child) : undefined)),
        );
        for (const r of running) {
          rmSync(r.unit.bundleDir, { recursive: true, force: true });
        }
        log.info(chalk.dim('Stopped the dev server.'));
        resolveRun();
      })();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
};

const hasPortlessUnit = (units: ServedUnit[]): boolean =>
  units.some((u) => u.portless !== undefined);

/**
 * Spawn the child for a unit. A portless unit is wrapped as `portless <slug> node
 * <runtime> <bundle>`: portless assigns a port, injects it as PORT (which the runtime
 * honors), and exposes the server at `slug.localhost`. A plain unit runs the bundled
 * output directly under `node`.
 *
 * Spawned detached (own process group) so killTree can reap the whole group — important
 * for the portless case, where the tree is portless -> node runtime.
 */
const spawnChild = (
  unit: ServedUnit,
  runtimePath: string,
  bundlePath: string,
): ChildProcess => {
  if (unit.portless) {
    return spawn(
      'portless',
      [unit.portless.slug, process.execPath, runtimePath, bundlePath],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: unit.childEnv,
        detached: true,
      },
    );
  }
  return spawn(process.execPath, [runtimePath, bundlePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: unit.childEnv,
    detached: true,
  });
};

/** Fail early with an actionable message if a portless unit is requested but the binary is missing. */
const assertPortlessAvailable = (): void => {
  const result = spawnSyncCheck('portless');
  if (!result) {
    throw new Error(
      'A function sets `dev.portless: true`, but the `portless` command was not ' +
        'found on your PATH. Install it globally (e.g. `npm i -g portless`) or ' +
        'remove `dev.portless` from the function in neon.ts.',
    );
  }
};

const spawnSyncCheck = (bin: string): boolean => {
  try {
    // Synchronous, no-side-effect probe: `which`/`where` resolves the binary.
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const { status } = spawnSync(probe, [bin]);
    return status === 0;
  } catch {
    return false;
  }
};

const writeBundle = async (
  source: string,
  bundleDir: string,
): Promise<string> => {
  const files = await bundleEntry(source);
  mkdirSync(bundleDir, { recursive: true });
  // The bundle is ESM (`format: 'esm'`), but it's written into a `.js` file under the
  // user's node_modules — where Node, finding no `"type"`, would treat `.js` as CommonJS
  // and throw `Unexpected token 'export'`. Drop a `package.json` marker so Node runs it as
  // ESM. (A bare `out.mjs` would also work but breaks the `out.js.map` sourcemap link.)
  writeFileSync(join(bundleDir, 'package.json'), '{"type":"module"}\n');
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(bundleDir, name), contents);
  }
  return join(bundleDir, 'out.js');
};

const urlFor = (port: number | null): string =>
  port === null ? chalk.red('not running') : `http://localhost:${port}`;

const waitForReady = (child: ChildProcess): Promise<number | null> =>
  new Promise<number | null>((resolveReady) => {
    let settled = false;
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const match = READY_PATTERN.exec(buffer);
      if (match && !settled) {
        settled = true;
        child.stdout?.off('data', onData);
        resolveReady(Number(match[1]));
      }
    };
    child.stdout?.on('data', onData);
    child.once('exit', () => {
      if (!settled) {
        settled = true;
        resolveReady(null);
      }
    });
  });

/**
 * Forward the child's stdout/stderr to the parent, swallowing the machine-readable
 * `neon-dev:ready` line. When `label` is set (multi-function mode), every line is
 * prefixed with `[slug]` so concurrent servers' output stays readable.
 */
const pipeChildOutput = (child: ChildProcess, label: string | null): void => {
  const prefix = label ? chalk.dim(`[${label}] `) : '';
  const forward = (stream: 'stdout' | 'stderr'): void => {
    let buffer = '';
    child[stream]?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (READY_PATTERN.test(line)) continue;
        process[stream].write(`${prefix}${line}\n`);
      }
    });
  };
  forward('stdout');
  forward('stderr');
};

const printBanner = (running: RunningUnit[]): void => {
  log.info('');
  log.info(chalk.green.bold('  Neon Functions dev server'));
  log.info('');
  for (const r of running) {
    const name = r.unit.label ?? 'function';
    const url = urlFor(r.boundPort);
    log.info(`  ${chalk.dim(name.padEnd(20))} ${url}`);
  }
  log.info('');
};

const logUnit = (unit: ServedUnit, message: string): void => {
  const prefix = unit.label ? chalk.dim(`[${unit.label}] `) : '';
  log.info(`${prefix}${message}`);
};

type Watcher = {
  sync: () => Promise<void>;
  close: () => Promise<void>;
};

const startWatcher = async (
  source: string,
  restart: () => void,
): Promise<Watcher> => {
  const { default: chokidar } = await import('chokidar');
  const initialInputs = await resolveWatchInputs(source);
  if (initialInputs === null) {
    return startDirectoryWatcher(chokidar, source, restart);
  }
  return startInputWatcher(chokidar, source, initialInputs, restart);
};

type Chokidar = typeof import('chokidar').default;

const startInputWatcher = async (
  chokidar: Chokidar,
  source: string,
  initialInputs: string[],
  restart: () => void,
): Promise<Watcher> => {
  const watched = new Set<string>([source, ...initialInputs]);
  const watcher = chokidar.watch([...watched], { ignoreInitial: true });
  await once(watcher, 'ready');
  watcher.on('all', () => {
    restart();
  });

  const sync = async (): Promise<void> => {
    const next = await resolveWatchInputs(source);
    if (next === null) return;
    const desired = new Set<string>([source, ...next]);
    for (const file of desired) {
      if (!watched.has(file)) {
        watcher.add(file);
        watched.add(file);
      }
    }
    for (const file of watched) {
      if (!desired.has(file)) {
        watcher.unwatch(file);
        watched.delete(file);
      }
    }
  };

  return { sync, close: () => watcher.close() };
};

const startDirectoryWatcher = async (
  chokidar: Chokidar,
  source: string,
  restart: () => void,
): Promise<Watcher> => {
  const watchedDir = dirname(source);
  const isIgnored = (p: string): boolean => {
    const segments = p.split(/[/\\]/);
    return (
      segments.includes('node_modules') ||
      segments.includes('.git') ||
      segments.includes('dist')
    );
  };
  const watcher = chokidar.watch(watchedDir, {
    ignoreInitial: true,
    ignored: (path: string) => isIgnored(path),
  });
  await once(watcher, 'ready');
  watcher.on('all', () => {
    restart();
  });
  return { sync: () => Promise.resolve(), close: () => watcher.close() };
};

/**
 * Terminate a child and every descendant it spawned. The child is started `detached`, so
 * on POSIX it leads its own process group and a negative-PID signal reaps the group
 * (covering portless -> neonctl -> node). On Windows there are no POSIX groups, so we
 * shell out to `taskkill /T` to kill the tree. Escalates SIGTERM -> SIGKILL after 2s.
 */
const killTree = (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  const pid = child.pid;
  return new Promise<void>((resolveKill) => {
    const timeout = setTimeout(() => {
      forceKill(child, pid);
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveKill();
    });
    if (pid !== undefined && process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGTERM');
        return;
      } catch {
        // Fall through to a direct kill if the group is already gone.
      }
    }
    child.kill('SIGTERM');
  });
};

const forceKill = (child: ChildProcess, pid: number | undefined): void => {
  if (pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
};

const resolveRuntimePath = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, '..', 'dev', 'runtime.js');
  if (!existsSync(candidate)) {
    throw new Error(`Could not locate the dev runtime at ${candidate}`);
  }
  return candidate;
};
