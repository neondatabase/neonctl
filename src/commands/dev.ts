import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import yargs from 'yargs';

import { log } from '../log.js';
import { bundleEntry } from '../utils/esbuild.js';
import { resolveDevEnv } from '../dev/env.js';
import { resolveWatchInputs } from '../dev/inputs.js';
import { branchIdResolve } from '../utils/enrichers.js';
import type { CommonProps } from '../types.js';

type DevProps = CommonProps & {
  source: string;
  port?: number;
  projectId?: string;
  branch?: string;
  id?: string;
};

export const command = 'dev';
export const describe = 'Run a Neon Function locally with a dev server';

export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 dev --source <path> [options]')
    .example(
      '$0 dev --source ./functions/hello.ts',
      'Serve one function on a free port with hot reload',
    )
    .example(
      '$0 dev --source ./functions/hello.ts --port 3000',
      'Serve on an explicit port (fails if the port is taken)',
    )
    .example(
      'portless run $0 dev --source ./functions/hello.ts',
      'Serve through portless (honors the injected PORT)',
    )
    .options({
      source: {
        describe: 'Path to the function entry module',
        type: 'string',
        demandOption: true,
      },
      port: {
        describe:
          'Port to listen on. Fails if taken. Without it (and without a ' +
          'PORT env var) a free port is chosen automatically.',
        type: 'number',
      },
    })
    .strict();

export const handler = async (props: DevProps): Promise<void> => {
  const source = resolve(process.cwd(), props.source);
  if (!existsSync(source)) {
    throw new Error(`Source file not found: ${source}`);
  }

  const neonEnv = await resolveNeonEnv(props);
  const childEnv = buildChildEnv(props.port, neonEnv);

  await runDevServer({
    source,
    cwd: process.cwd(),
    runtimePath: resolveRuntimePath(),
    childEnv,
  });
};

/**
 * Resolve the branch's Neon env vars to inject (see {@link resolveDevEnv}).
 * Requires an authenticated API client; without one (no credentials), env
 * injection is silently skipped so the function still runs locally.
 */
const resolveNeonEnv = async (
  props: DevProps,
): Promise<Record<string, string>> => {
  if (!props.apiClient || !props.projectId) {
    log.debug('dev: no API client / project context; skipping env injection');
    return resolveDevEnv({ cwd: process.cwd() });
  }

  let branchId: string | undefined;
  try {
    const branch = props.branch ?? props.id;
    branchId = branch
      ? await branchIdResolve({
          branch,
          apiClient: props.apiClient,
          projectId: props.projectId,
        })
      : undefined;
  } catch (err) {
    log.debug(
      'dev: could not resolve branch id: %s',
      err instanceof Error ? err.message : String(err),
    );
  }

  return resolveDevEnv({
    cwd: process.cwd(),
    projectId: props.projectId,
    ...(branchId ? { branchId } : {}),
    ...(props.apiKey ? { apiKey: props.apiKey } : {}),
  });
};

const DEFAULT_PORT_BASE = 8787;

/**
 * Build the child env. The Neon vars layer over the inherited environment (so
 * the branch's DATABASE_URL wins over a stale inherited value); a function that
 * loads its own `.env` at runtime still overrides them. Port resolution:
 *   1. `--port`              -> explicit, fail if taken
 *   2. `PORT` env (portless) -> explicit, fail if taken
 *   3. neither               -> search upward from the default base, never fail
 */
const buildChildEnv = (
  port: number | undefined,
  neonEnv: Record<string, string>,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...neonEnv };
  delete env.NEON_DEV_PORT;
  delete env.NEON_DEV_PORT_BASE;

  if (port !== undefined) {
    env.NEON_DEV_PORT = String(port);
    return env;
  }
  if (process.env.PORT !== undefined && process.env.PORT !== '') {
    env.NEON_DEV_PORT = process.env.PORT;
    return env;
  }
  env.NEON_DEV_PORT_BASE = String(DEFAULT_PORT_BASE);
  return env;
};

type DevServerOptions = {
  source: string;
  cwd: string;
  runtimePath: string;
  childEnv: NodeJS.ProcessEnv;
};

const READY_PATTERN = /neon-dev:ready (\d+)/;

const runDevServer = async (options: DevServerOptions): Promise<void> => {
  let child: ChildProcess | null = null;
  let boundPort: number | null = null;
  let shuttingDown = false;
  let restartTimer: NodeJS.Timeout | null = null;
  let everReady = false;
  let watcher: Watcher | null = null;

  // The bundle and its module resolution root live under the user's
  // node_modules so the function's npm deps (left external by the bundler)
  // resolve at runtime. Cleaned up on shutdown.
  const bundleDir = join(options.cwd, 'node_modules', '.neon-dev');

  const bundleAndStart = async (): Promise<number | null> => {
    let bundlePath: string;
    try {
      bundlePath = await writeBundle(options.source, bundleDir);
    } catch (err) {
      log.error(
        'Failed to bundle %s:\n%s',
        options.source,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }

    // Re-sync the watch set after every (re)bundle: imports can be added or
    // removed between edits, so the precise input list shifts over time.
    if (watcher) await watcher.sync();

    const next = spawn(process.execPath, [options.runtimePath, bundlePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.childEnv,
    });
    child = next;

    const ready = waitForReady(next);
    pipeChildOutput(next);

    next.on('exit', (code, signal) => {
      if (shuttingDown || child !== next) return;
      if (signal) {
        log.debug('runtime exited via %s', signal);
        return;
      }
      if (code && code !== 0 && everReady) {
        log.error('Function exited with code %d (waiting for a change)', code);
      }
    });

    const port = await ready;
    if (port !== null) {
      boundPort = port;
      everReady = true;
    }
    return port;
  };

  const restart = (): void => {
    if (shuttingDown) return;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      void (async () => {
        log.info(chalk.dim('Change detected, restarting…'));
        if (child) await killChild(child);
        if (shuttingDown) return;
        const port = await bundleAndStart();
        if (port !== null) {
          log.info(chalk.green('Ready') + ` ${urlFor(port)}`);
        }
      })();
    }, 150);
  };

  // Create the watcher before the first bundle so `bundleAndStart` can sync the
  // watch set on every run (including the initial one).
  watcher = await startWatcher(options.source, restart);

  const initialPort = await bundleAndStart();
  if (initialPort === null) {
    await watcher.close();
    throw new Error(
      'The function failed to start. See the output above for details.',
    );
  }
  printBanner(options.source, boundPort);

  const activeWatcher = watcher;
  await new Promise<void>((resolveRun) => {
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (restartTimer) clearTimeout(restartTimer);
      void (async () => {
        await activeWatcher.close();
        if (child) await killChild(child);
        rmSync(bundleDir, { recursive: true, force: true });
        log.info(chalk.dim('Stopped the dev server.'));
        resolveRun();
      })();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
};

/**
 * Bundle the source with the shared esbuild helper and write the output into
 * `bundleDir` (under the user's node_modules so external deps resolve). Returns
 * the path to the bundled entry.
 */
const writeBundle = async (
  source: string,
  bundleDir: string,
): Promise<string> => {
  const files = await bundleEntry(source);
  mkdirSync(bundleDir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(bundleDir, name), contents);
  }
  return join(bundleDir, 'out.js');
};

const urlFor = (port: number): string => `http://localhost:${port}`;

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
 * Forward the child's stdout/stderr to the parent, swallowing the
 * machine-readable `neon-dev:ready` line.
 */
const pipeChildOutput = (child: ChildProcess): void => {
  const forward = (stream: 'stdout' | 'stderr'): void => {
    let buffer = '';
    child[stream]?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (READY_PATTERN.test(line)) continue;
        process[stream].write(`${line}\n`);
      }
    });
  };
  forward('stdout');
  forward('stderr');
};

const printBanner = (source: string, boundPort: number | null): void => {
  log.info('');
  log.info(chalk.green.bold('  Neon Functions dev server'));
  log.info('');
  const url = boundPort === null ? chalk.red('not running') : urlFor(boundPort);
  log.info(`  ${chalk.dim('URL')}     ${url}`);
  log.info(`  ${chalk.dim('Source')}  ${source}`);
  log.info('');
};

type Watcher = {
  /** Re-derive the watch set and add/remove files to match. */
  sync: () => Promise<void>;
  close: () => Promise<void>;
};

const startWatcher = async (
  source: string,
  restart: () => void,
): Promise<Watcher> => {
  // chokidar is bundled with neonctl; import lazily to keep startup cheap.
  const { default: chokidar } = await import('chokidar');

  // Precise input watching: watch exactly the files esbuild reads to build the
  // bundle (entry + every local import) so a single edit triggers exactly one
  // rebuild. Falls back to directory watching when the input set is unavailable
  // (packaged binary / esbuild module won't load); `null` signals that case.
  const initialInputs = await resolveWatchInputs(source);

  if (initialInputs === null) {
    return startDirectoryWatcher(chokidar, source, restart);
  }
  return startInputWatcher(chokidar, source, initialInputs, restart);
};

type Chokidar = typeof import('chokidar').default;

/**
 * Watch a precise set of files (the bundle's inputs). `sync` re-derives the set
 * after each rebuild — adding newly-imported files and unwatching removed ones —
 * because the import graph can change between edits.
 */
const startInputWatcher = async (
  chokidar: Chokidar,
  source: string,
  initialInputs: string[],
  restart: () => void,
): Promise<Watcher> => {
  // Always keep the entry watched even if a transient bundle failure drops it
  // from the input set, so edits that fix the error are still detected.
  const watched = new Set<string>([source, ...initialInputs]);
  const watcher = chokidar.watch([...watched], { ignoreInitial: true });
  await once(watcher, 'ready');
  watcher.on('all', () => {
    restart();
  });

  const sync = async (): Promise<void> => {
    const next = await resolveWatchInputs(source);
    // A failed/unavailable re-resolve keeps the current set rather than dropping
    // everything — the next successful rebuild re-syncs it.
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

/**
 * Fallback when the precise input set is unavailable: watch the source's
 * directory. `ignored` is a path predicate (chokidar 5) matching on path
 * *segments* (not a substring like '/node_modules/') so the bare `node_modules`
 * directory event emitted when we write our bundle into node_modules/.neon-dev
 * is also ignored — otherwise it triggers an endless rebuild loop.
 */
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

const killChild = (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolveKill) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveKill();
    });
    child.kill('SIGTERM');
  });
};

/**
 * Locate the compiled runtime entry (`dist/dev/runtime.js`) relative to this
 * module (`dist/commands/dev.js`). Run in place by a plain `node` child, which
 * resolves the runtime's own imports (e.g. `@hono/node-server`) from neonctl's
 * node_modules.
 */
const resolveRuntimePath = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, '..', 'dev', 'runtime.js');
  if (!existsSync(candidate)) {
    throw new Error(`Could not locate the dev runtime at ${candidate}`);
  }
  return candidate;
};
