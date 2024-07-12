import yargs from 'yargs';
import { Context, updateContextFile } from '../context.js';
import { BranchScopeProps } from '../types.js';

export const command = 'set-context';
export const describe = 'Set the current context';
export const builder = (argv: yargs.Argv) =>
  argv.usage('$0 set-context [options]').options({
    'project-id': {
      describe: 'Project ID',
      type: 'string',
    },
  });

export const handler = (props: BranchScopeProps) => {
  const context: Context = {
    projectId: props.projectId,
  };
  updateContextFile(props.contextFile, context);
};
