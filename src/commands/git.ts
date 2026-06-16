import yargs from 'yargs';
import chalk from 'chalk';
import prompts from 'prompts';

import { toNeonBranchName } from '@neondatabase/config';

import {
  contextBranch,
  gitBranchMap,
  gitBranchMapping,
  readContextFile,
  setGitBranchMap,
  setGitBranchMapping,
  setGitFollow,
} from '../context.js';
import { isCi } from '../env.js';
import { log } from '../log.js';
import { CommonProps } from '../types.js';
import {
  currentGitBranch,
  GIT_HOOK_ENV_FLAG,
  gitPull,
  gitRepoRoot,
  hasUpstream,
  installPostCheckoutHook,
  isGitRepo,
  isManagedHook,
  localGitBranches,
  postCheckoutHookPath,
  readGitContext,
  removePostCheckoutHook,
} from '../utils/git.js';
import { handler as checkoutHandler } from './checkout.js';

type GitProps = CommonProps & {
  projectId?: string;
  orgId?: string;
  envPull?: boolean;
  quiet?: boolean;
  /** Tri-state: `--pull` (true), `--no-pull` (false), or unset (prompt in a manual TTY). */
  pull?: boolean;
  /** `git cleanup`: also delete the orphaned Neon branches (never default/protected). */
  pruneNeonBranches?: boolean;
  /** `git cleanup`: skip the deletion confirmation prompt. */
  yes?: boolean;
};

export const command = 'git';
export const describe =
  'Sync the checked-out Neon branch to your git branch (Preview)';
export const aliases: string[] = [];

export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 git <sub-command> [options]')
    .command(
      'install',
      'Install a git post-checkout hook that syncs the Neon branch on `git checkout`',
      (yargs) => yargs,
      (args) => {
        install(args as unknown as GitProps);
      },
    )
    .command(
      'uninstall',
      'Remove the git post-checkout hook installed by `git install`',
      (yargs) => yargs,
      (args) => {
        uninstall(args as unknown as GitProps);
      },
    )
    .command(
      'sync',
      'Check out the Neon branch mapped to the current git branch (run by the hook)',
      (yargs) =>
        yargs.options({
          'env-pull': {
            describe:
              "Pull the branch's Neon env vars into a local .env after sync. On by default.",
            type: 'boolean',
            default: true,
          },
          pull: {
            describe:
              'Run `git pull --ff-only` before syncing so local files (incl. migration ' +
              'files) match the branch before any checkout.after migration runs. Without ' +
              'the flag, prompts when run manually in a TTY and skips in the hook / CI.',
            type: 'boolean',
          },
          quiet: {
            describe: 'Reduce output (used by the git hook).',
            type: 'boolean',
            default: false,
          },
        }),
      (args) => sync(args as unknown as GitProps),
    )
    .command(
      'status',
      'Show the git context, hook state, and current git → Neon mapping',
      (yargs) => yargs,
      (args) => {
        status(args as unknown as GitProps);
      },
    )
    .command(
      'cleanup',
      'Prune git → Neon mappings whose local git branch is gone; optionally delete the orphaned Neon branches',
      (yargs) =>
        yargs.options({
          'prune-neon-branches': {
            describe:
              'Also delete the orphaned Neon branches (never the default or a protected branch).',
            type: 'boolean',
            default: false,
          },
          yes: {
            describe:
              'Skip the confirmation prompt before deleting Neon branches.',
            type: 'boolean',
            default: false,
          },
        }),
      (args) => cleanup(args as unknown as GitProps),
    )
    .demandCommand(1);

export const handler = (args: yargs.Argv) => args;

const requireRepoRoot = (): string | undefined => {
  const cwd = process.cwd();
  if (!isGitRepo(cwd)) {
    log.error(
      'Not inside a git repository. Run `neonctl git` from a git work tree.',
    );
    return undefined;
  }
  return gitRepoRoot(cwd);
};

export const install = (props: GitProps): void => {
  const repoRoot = requireRepoRoot();
  if (!repoRoot) return;

  const result = installPostCheckoutHook(repoRoot);
  if (result.status === 'conflict') {
    log.error(
      'A non-neonctl `post-checkout` hook already exists at %s.\n' +
        'Remove or rename it first, then re-run `neonctl git install`.',
      result.hookPath,
    );
    return;
  }
  setGitFollow(props.contextFile, true);
  log.info(
    'Git → Neon sync %s. `git checkout <branch>` will now check out the mapped Neon branch.\n' +
      'Hook: %s',
    result.status === 'installed' ? 'installed' : 'updated',
    postCheckoutHookPath(repoRoot),
  );
};

export const uninstall = (props: GitProps): void => {
  const repoRoot = requireRepoRoot();
  if (!repoRoot) return;

  const result = removePostCheckoutHook(repoRoot);
  setGitFollow(props.contextFile, false);
  switch (result) {
    case 'removed':
      log.info(
        'Removed the neonctl git post-checkout hook. Git → Neon sync is off.',
      );
      break;
    case 'foreign':
      log.warning(
        'Left the existing `post-checkout` hook in place (not managed by neonctl). ' +
          'Git → Neon sync flag cleared.',
      );
      break;
    case 'absent':
      log.info(
        'No neonctl git hook was installed. Git → Neon sync flag cleared.',
      );
      break;
  }
};

/**
 * Check out the Neon branch that corresponds to the current git branch. Invoked by the
 * installed `post-checkout` hook (with `NEON_GIT_HOOK=1`) and runnable by hand. Resolves the
 * Neon branch name via the persisted map (sticky), delegates to `neonctl checkout` (whose
 * `checkout.before` hook may further map the name and whose `checkout.after` hook runs
 * migrations, etc.), then records the resulting git → Neon mapping so it stays stable.
 */
export const sync = async (props: GitProps): Promise<void> => {
  const cwd = process.cwd();
  if (!isGitRepo(cwd)) {
    log.error('Not inside a git repository.');
    return;
  }
  const gitBranch = currentGitBranch(cwd);
  if (!gitBranch) {
    log.info('Detached HEAD — no git branch to sync. Skipping.');
    return;
  }

  // Optionally fast-forward local files (incl. committed migration files) before checkout, so
  // a shared branch that is ahead of your local tree doesn't leave code↔schema skewed when the
  // `checkout.after` migration runs. Opt-in (network + can diverge); see resolveShouldPull.
  if (await resolveShouldPull(props, cwd, gitBranch)) {
    const outcome = gitPull(cwd);
    switch (outcome.status) {
      case 'pulled':
        log.info('%s git pull --ff-only (%s)', chalk.dim('→'), gitBranch);
        break;
      case 'no-upstream':
        log.info('No upstream for %s — skipping git pull.', gitBranch);
        break;
      case 'failed':
        log.warning(
          'git pull --ff-only failed (continuing with sync): %s',
          outcome.detail,
        );
        break;
    }
  }

  const context = readContextFile(props.contextFile);
  // Resolve the Neon branch name to check out:
  //   1. a previously-recorded mapping wins (sticky — no duplicate branches), else
  //   2. a Neon-safe name derived from the git branch via `toNeonBranchName`.
  // (2) means a brand-new branch is always valid by default — no `checkout.before` hook
  // required. A `checkout.before` hook can still override: it receives this name as
  // `inputName` *and* the raw git branch on `git.branch`, so it can re-derive with custom
  // options (e.g. a `preview/` prefix) and stay stable.
  const inputName =
    gitBranchMapping(context, gitBranch) ?? toNeonBranchName(gitBranch);

  await checkoutHandler({
    ...props,
    id: inputName,
    envPull: props.envPull ?? true,
  });

  // Persist the mapping from the branch actually pinned, so subsequent checkouts of this git
  // branch resolve to the same Neon branch without re-deriving.
  const resolved = contextBranch(readContextFile(props.contextFile));
  if (resolved) {
    setGitBranchMapping(props.contextFile, gitBranch, resolved);
  }
};

/**
 * Decide whether `git sync` should `git pull` first. Mirrors the rest of the CLI's
 * auto-vs-interactive philosophy (cf. `checkout` / `link`): an explicit flag always wins;
 * otherwise we only *prompt* in a real manual TTY, and never auto-pull in the post-checkout
 * hook or CI (no network surprises in automation). Skips when there's nothing upstream.
 */
const resolveShouldPull = async (
  props: GitProps,
  cwd: string,
  gitBranch: string,
): Promise<boolean> => {
  if (props.pull === true) return true;
  if (props.pull === false) return false;
  if (!hasUpstream(cwd)) return false;
  const triggeredByGitHook = process.env[GIT_HOOK_ENV_FLAG] === '1';
  if (triggeredByGitHook || isCi() || !process.stdout.isTTY) return false;
  const { pull } = await prompts({
    type: 'confirm',
    name: 'pull',
    message: `Pull latest for "${gitBranch}" (git pull --ff-only) before syncing?`,
    initial: false,
  });
  return Boolean(pull);
};

export const status = (props: GitProps): void => {
  const cwd = process.cwd();
  const git = readGitContext(cwd);
  if (!git.available) {
    log.info('Not inside a git repository.');
    return;
  }

  const repoRoot = git.repoRoot ?? cwd;
  const hookPath = postCheckoutHookPath(repoRoot);
  const installed = isManagedHook(hookPath);
  const context = readContextFile(props.contextFile);
  const mapping = context.git?.map ?? {};
  const currentBranch = git.branch;
  const mappedNeon = currentBranch
    ? gitBranchMapping(context, currentBranch)
    : undefined;

  log.info('Git branch:        %s', chalk.cyan(currentBranch ?? '(detached)'));
  log.info('Hook installed:    %s', installed ? chalk.green('yes') : 'no');
  log.info(
    'Follow on checkout: %s',
    context.git?.follow ? chalk.green('yes') : 'no',
  );
  if (currentBranch) {
    log.info(
      'Maps to Neon:      %s',
      mappedNeon
        ? chalk.cyan(mappedNeon)
        : chalk.dim('(unmapped — will derive on next sync)'),
    );
  }
  const entries = Object.entries(mapping);
  if (entries.length > 0) {
    log.info('Known mappings:');
    for (const [g, n] of entries) {
      log.info('  %s → %s', g, n);
    }
  }
};

/** A Neon branch as far as pruning cares (the live list returns more). */
type PrunableBranch = {
  id: string;
  name: string;
  default?: boolean;
  protected?: boolean;
};

/**
 * Split the orphaned Neon branches (those mapped from now-deleted git branches) into the ones
 * safe to delete and the ones to skip. Default and protected branches are **never** deleted.
 * Pure (no I/O) so it's unit-testable.
 */
export const partitionBranchesToPrune = <B extends PrunableBranch>(
  branches: B[],
  orphanNeonNames: ReadonlySet<string>,
): { toDelete: B[]; skipped: { name: string; reason: string }[] } => {
  const toDelete: B[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const branch of branches) {
    if (!orphanNeonNames.has(branch.name)) continue;
    if (branch.default) {
      skipped.push({ name: branch.name, reason: 'default branch' });
    } else if (branch.protected) {
      skipped.push({ name: branch.name, reason: 'protected' });
    } else {
      toDelete.push(branch);
    }
  }
  return { toDelete, skipped };
};

/**
 * Prune the git → Neon workflow state. By default this only cleans `.neon`: mapping entries
 * whose git branch no longer exists locally are dropped. With `--prune-neon-branches` it also
 * deletes the orphaned Neon branches — never the default branch and never a protected one.
 */
export const cleanup = async (props: GitProps): Promise<void> => {
  const cwd = process.cwd();
  if (!isGitRepo(cwd)) {
    log.error('Not inside a git repository.');
    return;
  }

  const context = readContextFile(props.contextFile);
  const map = gitBranchMap(context);
  const entries = Object.entries(map);
  if (entries.length === 0) {
    log.info('No git → Neon mappings to clean up.');
    return;
  }

  const local = new Set(localGitBranches(cwd));
  const stale = entries.filter(([gitBranch]) => !local.has(gitBranch));
  if (stale.length === 0) {
    log.info(
      'All %d mapping(s) still have a local git branch — nothing to prune.',
      entries.length,
    );
    return;
  }

  // 1) Always prune the stale mappings from .neon (non-destructive to Neon).
  const kept = Object.fromEntries(
    entries.filter(([gitBranch]) => local.has(gitBranch)),
  );
  setGitBranchMap(props.contextFile, kept);
  log.info('Pruned %d stale mapping(s) from .neon:', stale.length);
  for (const [gitBranch, neonBranch] of stale) {
    log.info('  %s → %s', gitBranch, neonBranch);
  }

  // 2) Optionally delete the orphaned Neon branches.
  if (!props.pruneNeonBranches) {
    log.info(
      'Re-run with --prune-neon-branches to also delete the orphaned Neon branch(es).',
    );
    return;
  }

  if (!props.projectId) {
    log.error(
      'Cannot delete Neon branches: no project in context. Run `neonctl link` first.',
    );
    return;
  }

  const orphanNeonNames = new Set(stale.map(([, neonBranch]) => neonBranch));
  const branches = (
    await props.apiClient.listProjectBranches({ projectId: props.projectId })
  ).data.branches;
  const { toDelete, skipped } = partitionBranchesToPrune(
    branches,
    orphanNeonNames,
  );

  for (const { name, reason } of skipped) {
    log.warning(
      'Keeping Neon branch %s (%s) — never auto-deleted.',
      name,
      reason,
    );
  }

  if (toDelete.length === 0) {
    log.info('No orphaned Neon branches to delete.');
    return;
  }

  if (!(await confirmPrune(props, toDelete))) {
    log.info('Aborted — no Neon branches were deleted.');
    return;
  }

  for (const branch of toDelete) {
    await props.apiClient.deleteProjectBranch(props.projectId, branch.id);
    log.info('Deleted Neon branch %s (%s).', branch.name, branch.id);
  }
};

/**
 * Confirm deleting the orphaned Neon branches. Deletion is destructive, so an explicit
 * `--yes` wins; otherwise prompt in an interactive terminal, and refuse (with a warning) in
 * CI / non-interactive contexts rather than deleting without consent.
 */
const confirmPrune = async (
  props: GitProps,
  toDelete: PrunableBranch[],
): Promise<boolean> => {
  if (props.yes) return true;
  if (isCi() || !process.stdout.isTTY) {
    log.warning(
      'Refusing to delete %d Neon branch(es) non-interactively. Re-run with --yes to confirm.',
      toDelete.length,
    );
    return false;
  }
  const { ok } = await prompts({
    type: 'confirm',
    name: 'ok',
    message: `Delete ${toDelete.length} orphaned Neon branch(es): ${toDelete
      .map((branch) => branch.name)
      .join(', ')}?`,
    initial: false,
  });
  return Boolean(ok);
};
