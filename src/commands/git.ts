import yargs from 'yargs';
import chalk from 'chalk';

import {
  contextBranch,
  gitBranchMapping,
  readContextFile,
  setGitBranchMapping,
  setGitFollow,
} from '../context.js';
import { log } from '../log.js';
import { CommonProps } from '../types.js';
import {
  currentGitBranch,
  gitRepoRoot,
  installPostCheckoutHook,
  isGitRepo,
  isManagedHook,
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

  const context = readContextFile(props.contextFile);
  // A previously-resolved mapping wins (sticky); otherwise pass the git branch through and
  // let the policy's `checkout.before` hook (or the default derivation) name the Neon branch.
  const inputName = gitBranchMapping(context, gitBranch) ?? gitBranch;

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
