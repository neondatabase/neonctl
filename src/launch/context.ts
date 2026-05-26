/**
 * Build the `LaunchContext` (`{ gitBranch, flags, processEnv }`) the launcher
 * threads through every spec callback. Also exposes helpers for the
 * state-file precedence chain.
 *
 * Precedence for keys that may appear in both `process.env` and
 * `.neon-launch.env`:
 *
 *   process.env > .neon-launch.env > .neon middleware context
 *
 * That matches dotenv convention (env files are defaults; environment
 * overrides) and keeps CI safe — a stale committed `.neon-launch.env`
 * can't beat a properly-injected GH Actions secret.
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parse as parseEnvFile, stringify as stringifyEnvFile } from 'envfile';

import type { FlagValue, LaunchContext } from './config.js';

export const NEON_LAUNCH_ENV_FILE = '.neon-launch.env';

/**
 * Read `.neon-launch.env` if it exists. Returns an empty record otherwise.
 * envfile parses quoted/escaped values safely; we don't roll our own parser.
 */
export function readNeonLaunchEnv(repoRoot: string): Record<string, string> {
  const path = join(repoRoot, NEON_LAUNCH_ENV_FILE);
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  const parsed = parseEnvFile(raw);
  // envfile returns Record<string, string | undefined>; coalesce undefined to ''
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Atomically write `.neon-launch.env` (temp + rename). Merges with existing
 * values — caller passes only the keys they want to set/update.
 */
export function writeNeonLaunchEnv(
  repoRoot: string,
  updates: Record<string, string>,
): void {
  const path = join(repoRoot, NEON_LAUNCH_ENV_FILE);
  const existing = readNeonLaunchEnv(repoRoot);
  const merged = { ...existing, ...updates };
  const body = stringifyEnvFile(merged);
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, path);
}

/**
 * Resolve a state value with the documented precedence chain.
 *
 * `neonContext` is the third tier — the existing `enrichFromContext`
 * middleware reads `.neon` and sets values on the yargs context; the
 * caller passes that record here so we don't double-read the JSON.
 */
export function resolveStateValue(
  key: string,
  processEnv: NodeJS.ProcessEnv,
  neonLaunchEnv: Record<string, string>,
  neonContext: Record<string, string | undefined>,
): string | undefined {
  if (processEnv[key] !== undefined && processEnv[key] !== '')
    return processEnv[key];
  if (neonLaunchEnv[key] !== undefined && neonLaunchEnv[key] !== '')
    return neonLaunchEnv[key];
  const fromCtx = neonContext[key];
  if (fromCtx !== undefined && fromCtx !== '') return fromCtx;
  return undefined;
}

/**
 * Resolve the git branch with the following precedence chain:
 *
 *   --branch <name>            (CLI flag, passed in)
 *   $GITHUB_HEAD_REF           (GH Actions pull_request events run detached)
 *   $GITHUB_REF_NAME           (GH Actions on push events)
 *   git rev-parse --abbrev-ref HEAD
 *   ''                          (no git repo at all)
 *
 * If `git rev-parse` returns the literal `'HEAD'` (detached state, no CI
 * overrides), throws — that's never a useful branch name. Pass `--branch`
 * explicitly to bypass.
 */
export function resolveGitBranch(opts: {
  branchFlag?: string;
  processEnv: NodeJS.ProcessEnv;
  cwd: string;
}): string {
  if (opts.branchFlag && opts.branchFlag !== '') return opts.branchFlag;

  const env = opts.processEnv;
  if (env.GITHUB_HEAD_REF && env.GITHUB_HEAD_REF !== '')
    return env.GITHUB_HEAD_REF;
  if (env.GITHUB_REF_NAME && env.GITHUB_REF_NAME !== '')
    return env.GITHUB_REF_NAME;

  let fromGit = '';
  try {
    fromGit = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: opts.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // not a git repo, or git not on PATH
    return '';
  }

  if (fromGit === 'HEAD') {
    throw new Error(
      [
        '[neon launch] Could not determine git branch — HEAD is detached.',
        'Pass `--branch <name>` explicitly or set GITHUB_HEAD_REF.',
        '(On GitHub Actions `pull_request` events, use `--branch "${{ github.head_ref }}"`.)',
      ].join('\n'),
    );
  }

  return fromGit;
}

/**
 * Locate the repo root from a starting directory. Walks up looking for `.git`.
 * Falls back to the starting dir if none found (allows `neon launch` to run
 * against a non-git repo with explicit `--branch` and `postgres.name`).
 */
export function findRepoRoot(start: string): string {
  let cur = start;
  // Defensive cap so we don't infinite-loop on a weird FS.
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(join(cur, '.git'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return start; // hit FS root
    cur = parent;
  }
  return start;
}

/**
 * Build the LaunchContext from a yargs argv object + process env. The
 * caller supplies the recognized flag set + the parsed argv; we filter
 * everything else into `ctx.flags`.
 */
export function buildLaunchContext(opts: {
  argv: Record<string, unknown>;
  recognizedFlags: ReadonlySet<string>;
  branchFlag?: string;
  processEnv: NodeJS.ProcessEnv;
  cwd: string;
}): LaunchContext {
  const flags: Record<string, FlagValue> = {};
  for (const [k, v] of Object.entries(opts.argv)) {
    // Skip yargs internals + recognized flags (those go elsewhere).
    if (k === '_' || k === '--' || k === '$0') continue;
    if (opts.recognizedFlags.has(k)) continue;
    if (
      typeof v === 'string' ||
      typeof v === 'boolean' ||
      typeof v === 'number'
    ) {
      flags[k] = v;
      continue;
    }
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      flags[k] = v;
      continue;
    }
    // Skip anything else (objects from yargs internals, etc.).
  }

  const gitBranch = resolveGitBranch({
    branchFlag: opts.branchFlag,
    processEnv: opts.processEnv,
    cwd: opts.cwd,
  });

  return {
    gitBranch,
    flags,
    processEnv: opts.processEnv,
  };
}
