import yargs from 'yargs';
import { Context, updateContextFile } from '../context.js';
import { branchIdFromProps } from '../utils/enrichers.js';
import { BranchScopeProps } from '../types.js';

export const command = 'set-context';
export const describe = 'Set the current context';
export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 set-context [options]')
    .options({
      'project-id': {
        describe: 'Project ID',
        type: 'string',
      },
      branch: {
        describe: 'Branch ID or name',
        type: 'string',
      },
    });

export const handler = async (props: BranchScopeProps) => {
  const branchId = await branchIdFromProps(props);
  const context: Context = {
    projectId: props.projectId,
    branchId,
  };
  updateContextFile(props.contextFile, context);
};
