import yargs from 'yargs';
import { applyContext, Context } from '../context.js';
import { log } from '../log.js';
import { CommonProps } from '../types.js';

/**
 * `set-context` is **deprecated** in favor of `link`. It is intentionally left
 * with its original behavior — a dumb, offline write of exactly the fields you
 * pass (no org inference, no verification, no env pull) — so existing scripts
 * keep working unchanged. The only addition is a deprecation warning (to stderr,
 * so it never pollutes stdout). New work should use `link`, which resolves and
 * verifies inputs; `neonctl link --no-checks` is the closest write-without-checks
 * equivalent of the old `set-context`.
 */
type SetContextProps = {
  projectId?: string;
  orgId?: string;
  branchId?: string;
};

export const command = 'set-context';
export const describe =
  'Deprecated: use `neonctl link`. Set the .neon context (raw write).';
export const builder = (argv: yargs.Argv) =>
  argv.usage('$0 set-context [options]').options({
    'project-id': {
      describe: 'Project ID',
      type: 'string',
    },
    'org-id': {
      describe: 'Organization ID',
      type: 'string',
    },
    'branch-id': {
      describe: 'Branch ID',
      type: 'string',
    },
  });

export const handler = (props: CommonProps & SetContextProps) => {
  log.warning(
    '`neonctl set-context` is deprecated and will be removed in a future release. ' +
      'Use `neonctl link` instead — it verifies inputs and infers the org for you ' +
      '(or `neonctl link --no-checks` for the same write-without-checks behavior).',
  );
  const context: Context = {
    projectId: props.projectId,
    orgId: props.orgId,
    branchId: props.branchId,
  };
  applyContext(props.contextFile, context);
};
