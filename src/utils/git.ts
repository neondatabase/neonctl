import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import type { GitContext } from '@neondatabase/config';

import { log } from '../log.js';

/**
 * Env var the installed `post-checkout` hook sets before invoking `neonctl git sync`, so the
 * CLI can tell a hook-triggered run from a manual `neonctl checkout` / `deploy`. Surfaced on
 * {@link GitContext.triggeredByGitHook} so a `checkout.before` hook can decide whether to
 * follow `git.branch` or honor the explicit `inputName`.
 */
export const GIT_HOOK_ENV_FLAG = 'NEON_GIT_HOOK';

/** Sentinel marking the `post-checkout` hook as neonctl-managed (safe to update/remove). */
const HOOK_SENTINEL =
  '# neonctl:git-sync (managed — edit `neonctl git` instead)';

const POST_CHECKOUT_HOOK = `#!/usr/bin/env sh
${HOOK_SENTINEL}
# Syncs the Neon branch to the checked-out git branch. Runs only on branch switches
# ($3 == 1), never blocks the checkout, and no-ops when neonctl isn't on PATH.
[ "$3" = "1" ] || exit 0
command -v neonctl >/dev/null 2>&1 || exit 0
${GIT_HOOK_ENV_FLAG}=1 neonctl git sync --quiet || true
`;

/** Run a git command, returning trimmed stdout, or `undefined` on any failure. */
const git = (args: string[], cwd: string): string | undefined => {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
};

/** Whether `cwd` is inside a git work tree. */
export const isGitRepo = (cwd: string): boolean =>
  git(['rev-parse', '--is-inside-work-tree'], cwd) === 'true';

/** Absolute path to the repository root (`git rev-parse --show-toplevel`), if any. */
export const gitRepoRoot = (cwd: string): string | undefined =>
  git(['rev-parse', '--show-toplevel'], cwd);

/** The current branch name, or `undefined` in detached-HEAD state / outside a repo. */
export const currentGitBranch = (cwd: string): string | undefined => {
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  return branch && branch.length > 0 ? branch : undefined;
};

/**
 * Read the read-only git facts the hooks receive. Never throws: outside a repo (or with git
 * uninstalled) it returns `{ available: false, … }` with the optional fields absent.
 *
 * @param cwd directory to inspect.
 * @param options.triggeredByGitHook whether this invocation came from the post-checkout hook.
 */
export const readGitContext = (
  cwd: string,
  options: { triggeredByGitHook?: boolean } = {},
): GitContext => {
  const triggeredByGitHook = options.triggeredByGitHook ?? false;
  if (!isGitRepo(cwd)) {
    return {
      available: false,
      isDetached: false,
      isDirty: false,
      triggeredByGitHook,
    };
  }

  const branch = currentGitBranch(cwd);
  const sha = git(['rev-parse', 'HEAD'], cwd);
  const shortSha = git(['rev-parse', '--short', 'HEAD'], cwd);
  const status = git(['status', '--porcelain'], cwd);
  // `origin/HEAD` -> e.g. "origin/main"; strip the remote prefix for the bare default branch.
  const remoteHead = git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], cwd);
  const defaultBranch = remoteHead?.startsWith('origin/')
    ? remoteHead.slice('origin/'.length)
    : undefined;
  const remoteUrl = git(['remote', 'get-url', 'origin'], cwd);
  const repoRoot = gitRepoRoot(cwd);

  return {
    available: true,
    isDetached: branch === undefined,
    isDirty: status !== undefined && status.length > 0,
    triggeredByGitHook,
    ...(branch ? { branch } : {}),
    ...(sha ? { sha } : {}),
    ...(shortSha ? { shortSha } : {}),
    ...(defaultBranch ? { defaultBranch } : {}),
    ...(remoteUrl ? { remoteUrl } : {}),
    ...(repoRoot ? { repoRoot } : {}),
  };
};

/**
 * Path to the `post-checkout` hook for a repo. Uses `git rev-parse --git-path hooks` so it
 * honors whatever git itself would use — `.git/hooks`, a `core.hooksPath` override (relative
 * or absolute), worktrees, etc. — instead of re-deriving the rules by hand.
 */
export const postCheckoutHookPath = (repoRoot: string): string => {
  const hooksDir = git(['rev-parse', '--git-path', 'hooks'], repoRoot);
  const dir = hooksDir
    ? isAbsolute(hooksDir)
      ? hooksDir
      : resolve(repoRoot, hooksDir)
    : resolve(repoRoot, '.git', 'hooks');
  return resolve(dir, 'post-checkout');
};

/** Whether a `post-checkout` hook exists and is neonctl-managed (carries our sentinel). */
export const isManagedHook = (hookPath: string): boolean => {
  if (!existsSync(hookPath)) return false;
  try {
    return readFileSync(hookPath, 'utf-8').includes(HOOK_SENTINEL);
  } catch {
    return false;
  }
};

export type InstallHookResult =
  | { status: 'installed' }
  | { status: 'updated' }
  | { status: 'conflict'; hookPath: string };

/**
 * Install (or refresh) the neonctl-managed `post-checkout` hook. Refuses to clobber a
 * pre-existing hook we don't own, returning `{ status: 'conflict' }` so the caller can warn
 * instead of silently overwriting the user's script.
 */
export const installPostCheckoutHook = (
  repoRoot: string,
): InstallHookResult => {
  const hookPath = postCheckoutHookPath(repoRoot);
  const existed = existsSync(hookPath);
  if (existed && !isManagedHook(hookPath)) {
    return { status: 'conflict', hookPath };
  }
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, POST_CHECKOUT_HOOK);
  chmodSync(hookPath, 0o755);
  return { status: existed ? 'updated' : 'installed' };
};

export type RemoveHookResult = 'removed' | 'absent' | 'foreign';

/** Remove the managed `post-checkout` hook. Leaves a foreign (user-authored) hook untouched. */
export const removePostCheckoutHook = (repoRoot: string): RemoveHookResult => {
  const hookPath = postCheckoutHookPath(repoRoot);
  if (!existsSync(hookPath)) return 'absent';
  if (!isManagedHook(hookPath)) return 'foreign';
  rmSync(hookPath);
  log.debug('Removed managed post-checkout hook at %s', hookPath);
  return 'removed';
};
