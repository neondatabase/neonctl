import yargs from 'yargs';

import { CommonProps } from '../types.js';
import { writer } from '../writer.js';

const ORG_FIELDS = ['id', 'name'] as const;

export const command = 'orgs';
export const describe = 'Manage organizations';
export const aliases = ['org'];
export const builder = (argv: yargs.Argv) => {
  return argv.usage('$0 orgs <sub-command> [options]').command(
    'list',
    'List organizations',
    (yargs) => yargs,
    async (args) => {
      // @ts-expect-error: TODO - Assert `args` is `CommonProps`
      await list(args);
    },
  );
};
export const handler = (args: yargs.Argv) => {
  return args;
};

const list = async (props: CommonProps) => {
  const out = writer(props);

  const {
    data: { organizations },
  } = await props.apiClient.getCurrentUserOrganizations();

  out.write(organizations, {
    fields: ORG_FIELDS,
    title: 'Organizations',
  });
  out.end();
};
