import chalk from 'chalk';

import { log } from '../log.js';
import type { ResolvedBranchRef } from './enrichers.js';

/**
 * Print a one-line "this command is targeting <branch>" notice to **stderr** so
 * the user can sanity-check they're acting on the branch they think they are —
 * before a `status` / `plan` / `apply` / `env pull` does its work. This is the
 * cheap guardrail that catches "I planned against the wrong branch" / "I pulled
 * env from the wrong branch" before it bites.
 *
 * - Skipped for machine-readable output (`--output json|yaml`) so it never has
 *   to be reasoned about by a script; it's stderr-only regardless, keeping
 *   `--output table` stdout clean for piping too.
 * - `verb` is the leading phrase, e.g. `'Planning against branch'` →
 *   `→ Planning against branch main (br-…)`.
 */
export const announceTargetBranch = (
  props: { output?: 'json' | 'yaml' | 'table' },
  branch: ResolvedBranchRef,
  verb: string,
): void => {
  if (props.output === 'json' || props.output === 'yaml') {
    return;
  }
  const suffix = branch.usedDefault ? chalk.dim(' · project default') : '';
  log.info(
    '%s %s %s %s%s',
    chalk.dim('→'),
    verb,
    chalk.cyan.bold(branch.branchName),
    chalk.dim(`(${branch.branchId})`),
    suffix,
  );
};
