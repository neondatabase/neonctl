import yargs from 'yargs';
import { applyContext, Context } from '../context.js';
import { CommonProps } from '../types.js';

type SetContextProps = {
  projectId?: string;
  orgId?: string;
  branchId?: string;
};

export const command = 'set-context';
export const describe = 'Set default project and org for subsequent commands';
export const builder = (argv: yargs.Argv) =>
  argv
    .usage(
      '$0 set-context [options]\n\nSave default project and org to the .neon context file, used by all subsequent commands. Omit all options to clear the context.',
    )
    .options({
      'project-id': {
        describe: 'Default project ID for subsequent commands',
        type: 'string',
      },
      'org-id': {
        describe: 'Default organization ID for subsequent commands',
        type: 'string',
      },
      'branch-id': {
        describe: 'Default branch ID for subsequent commands',
        type: 'string',
      },
    })
    .example([
      [
        '$0 set-context --project-id my-project-id',
        'Set the active project (avoids passing --project-id to every command)',
      ],
      [
        '$0 set-context',
        'Clear context — subsequent commands will require explicit IDs',
      ],
    ]);

export const handler = (props: CommonProps & SetContextProps) => {
  const context: Context = {
    projectId: props.projectId,
    orgId: props.orgId,
    branchId: props.branchId,
  };
  applyContext(props.contextFile, context);
};
