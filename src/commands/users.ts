import yargs from 'yargs';

import { CommonProps } from '../types';
import { writeOut } from '../writer';

export const command = 'me';
export const describe = 'Show current user';
export const builder = (yargs: yargs.Argv) => yargs;
export const handler = async (args: CommonProps) => {
  await me(args);
};

const me = async (props: CommonProps) => {
  writeOut(props)((await props.apiClient.getCurrentUserInfo()).data, {
    fields: ['login', 'email', 'name', 'projects_limit'],
  });
};
