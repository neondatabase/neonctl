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
  const { vars: neonEnv, skipped } = await resolveDevEnv({
    cwd: process.cwd(),
    ...(props.projectId ? { projectId: props.projectId } : {}),
    ...(branchId ? { branchId } : {}),
    ...(props.apiKey ? { apiKey: props.apiKey } : {}),
    ...(props.apiHost ? { apiHost: props.apiHost } : {}),
  });

  const unit: ServedUnit = {
    slug: null,
    source,
    bundleDir: join(process.cwd(), 'node_modules', '.neon-dev'),
    childEnv: buildChildEnv(neonEnv, portFromProps(props.port)),
    label: null,
    envSummary: { neon: Object.keys(neonEnv), fn: [] },
  };

  // No config reload in single-source mode: there's exactly one file to serve, and
  // nothing to add or remove. neon.ts hot-reload is config-mode only.
  await runSupervisor([unit], {
    ...(skipped ? { envNote: skipped.reason } : {}),
  });
};

/**
 * Multi-function mode: serve every function declared in neon.ts. Requires a neon.ts
 * (there is no single source to fall back on), one dev server per function.
 */
const runFromConfig = async (props: DevProps): Promise<void> => {
  const branchId = await resolveBranchId(props);
  const resolved = await resolveFunctionsFromConfig(process.cwd());

  if (resolved === null) {
    throw new Error(
      'No --source given and no neon.ts found. Pass --source <path> to run a ' +
        'single function, or add a neon.ts that declares functions under ' +
        '`preview.functions`.',
    );
  }
  const { configPath, functions } = resolved;
  if (functions.length === 0) {
    throw new Error(
      'neon.ts has no functions to serve. Add at least one under ' +
        '`preview.functions`, or pass --source <path>.',
    );
  }

  const { vars: neonEnv, skipped } = await resolveDevEnv({
    cwd: process.cwd(),
    ...(props.projectId ? { projectId: props.projectId } : {}),
    ...(branchId ? { branchId } : {}),
    ...(props.apiKey ? { apiKey: props.apiKey } : {}),
    ...(props.apiHost ? { apiHost: props.apiHost } : {}),
  });

  const units = planFunctionsToUnits(functions, neonEnv, DEFAULT_PORT_BASE);

  // Re-derive the units from neon.ts on demand so the config watcher can hot-add/remove
  // functions without restarting the dev server. `searchBase` lets a freshly-added unit
  // start probing above the ports already taken by live units (the runtime still walks
  // upward from there, so this never fails — it just keeps startup deterministic).
  const replan: Replan = async (searchBase) => {
    const re = await resolveFunctionsFromConfig(process.cwd());
    if (re === null) return null;
    return planFunctionsToUnits(re.functions, neonEnv, searchBase);
  };

  await runSupervisor(units, {
    reload: { configPath, replan },
    ...(skipped ? { envNote: skipped.reason } : {}),
  });
};

/** Re-resolve neon.ts into units, searching ports from `searchBase`. `null` if neon.ts vanished. */
type Replan = (searchBase: number) => Promise<ServedUnit[] | null>;

/** Extra wiring the supervisor needs to hot-reload neon.ts (config mode only). */
type ConfigReload = {
  configPath: string;
  replan: Replan;
};

/** Options for {@link runSupervisor}. */
type SupervisorOptions = {
  /** Present in config mode: lets the supervisor watch neon.ts and reconcile the unit set. */
  reload?: ConfigReload;
  /**
   * A calm, one-line reason shown in the banner when no Neon branch env could be injected
   * (e.g. not linked). Functions still run; this just explains the absence of DATABASE_URL.
   */
  envNote?: string;
};

/**
 * Map a list of {@link PlannedFunction}s to {@link ServedUnit}s, coordinating the search
 * base across them so search-mode functions don't all probe the same starting port.
 *
 * Each search-mode (no `dev.port`, non-portless) function gets a distinct base starting at
 * `searchBase`; the runtime still walks upward from its base, so an occupied base
 * self-resolves and this never fails — the offset just makes startup deterministic.
 */
const planFunctionsToUnits = (
  functions: PlannedFunction[],
  neonEnv: Record<string, string>,
  searchBase: number,
): ServedUnit[] => {
  let searchOffset = 0;
  return functions.map((fn) => {
    const base = searchBase + searchOffset;
    if (!fn.portless && fn.port === undefined) searchOffset += 1;
    return plannedToUnit(fn, neonEnv, base);
  });
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
    envSummary: { neon: Object.keys(branchEnv), fn: Object.keys(fn.env) },
    // Signature of the function's *own* neon.ts config (NOT the dynamically-chosen search
    // base) so reconcile can tell a real change from a no-op save. A search-mode function
    // re-planned with a different base must hash identically, or it would be needlessly
    // restarted — see reconcile().
    configKey: JSON.stringify({
      source: fn.source,
      port: fn.port ?? null,
      portless: fn.portless,
      env: fn.env,
    }),
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
export type ServedUnit = {
  slug: string | null;
  source: string;
  bundleDir: string;
  childEnv: NodeJS.ProcessEnv;
  label: string | null;
  /**
   * Signature of the function's own neon.ts config (source/port/portless/env), used by the
   * config reconciler to detect a real change vs a no-op save. Independent of the dynamic
   * port search base. Absent in single-source mode (no reconcile there).
   */
  configKey?: string;
  /**
   * The env-var *names* injected into this unit, split by origin, for a transparent dev
   * banner: `neon` are the Neon branch vars (DATABASE_URL, …), `fn` are the keys from this
   * function's `neon.ts` `env` block. Values are intentionally omitted (secrets).
   */
  envSummary?: { neon: string[]; fn: string[] };
  portless?: { slug: string };
};

export type RunningUnit = {
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
 *
 * In config mode, `reload` lets the supervisor watch `neon.ts` and reconcile the live set
 * of units when it changes: a newly-declared function is hot-added (its own child, watcher,
 * and port) and a removed one is torn down — all without disturbing the functions that
 * stayed the same. A function whose config (env/port/portless/source) changed is restarted
 * in place; siblings are untouched.
 */
const runSupervisor = async (
  units: ServedUnit[],
  options: SupervisorOptions = {},
): Promise<void> => {
  const { reload, envNote } = options;
  if (hasPortlessUnit(units)) {
    assertPortlessAvailable();
  }

  const runtimePath = resolveRuntimePath();
  let shuttingDown = false;

  const running: RunningUnit[] = units.map(makeRunningUnit);

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

  // Bring a unit fully online: create its source watcher (before the first bundle so
  // bundleAndStart can sync the watch set on every run) then bundle + spawn it.
  const startUnit = async (r: RunningUnit): Promise<void> => {
    r.watcher = await startWatcher(r.unit.source, () => {
      restart(r);
    });
    await bundleAndStart(r);
  };

  // Tear a unit down completely: stop its restart timer + watcher, reap its child tree, and
  // remove its bundle dir. Used both on shutdown and when neon.ts drops a function.
  const stopUnit = async (r: RunningUnit): Promise<void> => {
    if (r.restartTimer) clearTimeout(r.restartTimer);
    await r.watcher?.close();
    if (r.child) await killTree(r.child);
    rmSync(r.unit.bundleDir, { recursive: true, force: true });
  };

  // Start every unit. They are independent: keep going if one fails.
  await Promise.all(running.map((r) => startUnit(r)));

  if (running.every((r) => r.status === 'error')) {
    await Promise.all(running.map((r) => stopUnit(r)));
    throw new Error('No function started. See the output above for details.');
  }

  printBanner(running, envNote);

  // Config mode only: watch neon.ts and reconcile the live unit set when it changes.
  // Reconciles are serialized: a burst of saves (editor write-then-format) must not run
  // overlapping diffs against the mutating `running` array. A trailing run coalesces the
  // burst and picks up the latest config.
  let configWatcher: Watcher | null = null;
  if (reload) {
    const ops: ReconcileOps = {
      isShuttingDown: () => shuttingDown,
      startUnit,
      stopUnit,
      restartUnit: restart,
    };
    let inFlight: Promise<void> | null = null;
    let pending = false;
    const drive = (): void => {
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = (async () => {
        do {
          pending = false;
          await reconcileOnce(running, reload.replan, ops);
        } while (pending && !shuttingDown);
      })().finally(() => {
        inFlight = null;
      });
    };
    configWatcher = await startConfigWatcher(reload.configPath, drive);
  }

  await new Promise<void>((resolveRun) => {
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      void (async () => {
        await configWatcher?.close();
        await Promise.all(running.map((r) => stopUnit(r)));
        log.info(chalk.dim('Stopped the dev server.'));
        resolveRun();
      })();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
};

const makeRunningUnit = (unit: ServedUnit): RunningUnit => ({
  unit,
  child: null,
  boundPort: null,
  everReady: false,
  restartTimer: null,
  watcher: null,
  status: 'starting',
});

/** Lifecycle hooks the reconciler drives, supplied by {@link runSupervisor}. */
type ReconcileOps = {
  isShuttingDown: () => boolean;
  startUnit: (r: RunningUnit) => Promise<void>;
  stopUnit: (r: RunningUnit) => Promise<void>;
  restartUnit: (r: RunningUnit) => void;
};

/**
 * The converging actions of one reconcile, computed by the pure {@link diffUnits} and then
 * carried out by {@link reconcileOnce}. Splitting the decision from the side effects keeps
 * the slug-diff logic testable without spawning real children.
 */
export type ReconcilePlan = {
  /** Live units whose slug disappeared from neon.ts — torn down. */
  remove: RunningUnit[];
  /** Live units whose function config changed — restarted in place (kept, not replaced). */
  restart: RunningUnit[];
  /** Units for slugs newly declared in neon.ts — hot-added. */
  add: ServedUnit[];
};

/**
 * Pure slug-keyed diff of the live units against the freshly-resolved desired set:
 *   - a slug present now but not before → **add** (new child + watcher + port),
 *   - a slug gone from neon.ts → **remove** (torn down),
 *   - a slug whose config (source/port/portless/env) changed → **restart** in place,
 *   - an unchanged slug → left out of the plan entirely (never touched).
 * Functions that stayed the same never die, so an edit that only adds a function is
 * non-disruptive. `desired === null` (neon.ts deleted) is treated as "no functions".
 */
export const diffUnits = (
  running: RunningUnit[],
  desired: ServedUnit[] | null,
): ReconcilePlan => {
  const desiredBySlug = new Map<string, ServedUnit>();
  for (const u of desired ?? []) {
    if (u.slug !== null) desiredBySlug.set(u.slug, u);
  }
  const runningBySlug = new Map<string, RunningUnit>();
  for (const r of running) {
    if (r.unit.slug !== null) runningBySlug.set(r.unit.slug, r);
  }

  const plan: ReconcilePlan = { remove: [], restart: [], add: [] };

  for (const [slug, r] of runningBySlug) {
    if (!desiredBySlug.has(slug)) plan.remove.push(r);
  }
  for (const [slug, want] of desiredBySlug) {
    const r = runningBySlug.get(slug);
    if (r) {
      if (r.unit.configKey !== want.configKey) {
        r.unit = want;
        plan.restart.push(r);
      }
    } else {
      plan.add.push(want);
    }
  }
  return plan;
};

/**
 * Run one reconcile: re-resolve neon.ts (ignoring the change with a clear message if it no
 * longer loads), {@link diffUnits} against the live set, then apply the plan — tearing down
 * removed functions, restarting changed ones in place, and hot-adding new ones. Mutates
 * `running` in place so the surrounding supervisor sees the converged set.
 */
const reconcileOnce = async (
  running: RunningUnit[],
  replan: Replan,
  ops: ReconcileOps,
): Promise<void> => {
  if (ops.isShuttingDown()) return;

  let desired: ServedUnit[] | null;
  try {
    desired = await replan(nextSearchBase(running));
  } catch (err) {
    log.info(
      chalk.red('neon.ts change ignored: ') +
        (err instanceof Error ? err.message : String(err)) +
        chalk.dim(' (fix it and save again)'),
    );
    return;
  }
  if (ops.isShuttingDown()) return;

  if (hasPortlessUnit(desired ?? [])) assertPortlessAvailable();

  const plan = diffUnits(running, desired);

  for (const r of plan.remove) {
    logUnit(r.unit, chalk.dim('removed from neon.ts, stopping…'));
    await ops.stopUnit(r);
    const idx = running.indexOf(r);
    if (idx !== -1) running.splice(idx, 1);
  }

  for (const r of plan.restart) ops.restartUnit(r);

  if (plan.add.length > 0) {
    const added = plan.add.map((unit) => {
      const r = makeRunningUnit(unit);
      running.push(r);
      logUnit(unit, chalk.dim('added in neon.ts, starting…'));
      return r;
    });
    await Promise.all(added.map((r) => ops.startUnit(r)));
    for (const r of added) {
      if (r.status === 'ready') {
        const env = formatEnvSummary(r.unit.envSummary);
        logUnit(
          r.unit,
          chalk.green('ready') +
            ` ${urlFor(r.boundPort)}` +
            (env ? chalk.dim(`  ${env}`) : ''),
        );
      }
    }
  }
};

/**
 * Choose a port search base above every port the live units already bound, so a hot-added
 * search-mode function starts probing where there's room. The runtime still walks upward
 * from here, so it never fails even if this guess is taken — it just keeps things tidy.
 */
const nextSearchBase = (running: RunningUnit[]): number => {
  let max = DEFAULT_PORT_BASE - 1;
  for (const r of running) {
    if (r.boundPort !== null && r.boundPort > max) max = r.boundPort;
  }
  return max + 1;
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
  // bundleEntry emits `index.mjs` (+ `index.mjs.map`). The `.mjs` extension makes Node load
  // it as ESM directly, so no `package.json` `"type": "module"` marker is needed, and esbuild
  // points the sourcemap link at `index.mjs.map` for us.
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(bundleDir, name), contents);
  }
  return join(bundleDir, 'index.mjs');
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

const printBanner = (running: RunningUnit[], envNote?: string): void => {
  log.info('');
  log.info(chalk.green.bold('  Neon Functions dev server'));
  log.info('');
  for (const r of running) {
    const name = r.unit.label ?? 'function';
    const url = urlFor(r.boundPort);
    log.info(`  ${chalk.dim(name.padEnd(20))} ${url}`);
    const env = formatEnvSummary(r.unit.envSummary);
    if (env) log.info(`  ${' '.repeat(20)} ${chalk.dim(env)}`);
  }
  if (envNote) {
    log.info('');
    log.info(`  ${chalk.yellow('!')} ${chalk.dim(`Neon env: ${envNote}`)}`);
  }
  log.info('');
};

/**
 * Render a unit's injected env into one transparent line for the banner, e.g.
 * `env: DATABASE_URL, DATABASE_URL_UNPOOLED · neon.ts: RESEND_API_KEY`. Var **names** only
 * (never values — they're secrets). Returns `''` when nothing is injected, so the caller can
 * skip the line. Exported for unit testing.
 */
export const formatEnvSummary = (summary: ServedUnit['envSummary']): string => {
  if (!summary) return '';
  const parts: string[] = [];
  if (summary.neon.length > 0) {
    parts.push(`env: ${[...summary.neon].sort().join(', ')}`);
  }
  if (summary.fn.length > 0) {
    parts.push(`neon.ts: ${[...summary.fn].sort().join(', ')}`);
  }
  return parts.join(' · ');
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

/**
 * Watch the neon.ts file itself for changes, firing `onChange` on every save. Used by the
 * supervisor (config mode only) to hot-add/remove/restart functions when the declared set
 * changes. We watch the single config file rather than its import graph: editing neon.ts to
 * add or remove a function is the case that matters, and a plain file watch is robust where
 * the esbuild-based input resolution (built for function bundles) is not a fit for a
 * jiti-loaded config.
 */
const startConfigWatcher = async (
  configPath: string,
  onChange: () => void,
): Promise<Watcher> => {
  const { default: chokidar } = await import('chokidar');
  const watcher = chokidar.watch(configPath, { ignoreInitial: true });
  await once(watcher, 'ready');
  watcher.on('all', () => {
    onChange();
  });
  return { sync: () => Promise.resolve(), close: () => watcher.close() };
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
