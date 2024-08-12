import yargs from 'yargs';
import { Context, updateContextFile } from '../context.js';
import { CommonProps } from '../types.js';

type SetContextProps = {
  projectId?: string;
  orgId?: string;
};

export const command = 'set-context';
export const describe = 'Set the current context';
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
  });

export const handler = (props: CommonProps & SetContextProps) => {
  const context: Context = {
    projectId: props.projectId,
    orgId: props.orgId,
  };
  updateContextFile(props.contextFile, context);
};
