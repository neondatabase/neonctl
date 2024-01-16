import yargs from 'yargs';
import { CommonProps, IdOrNameProps, ProjectScopeProps } from '../types';
import { writer } from '../writer.js';
import { Project } from '@neondatabase/api-client';

interface IPAllowFields {
  id: string;
  name: string;
  IP_addresses: string;
  primary_branch_only: boolean;
}

const IP_ALLOW_FIELDS = [
  'id',
  'name',
  'IP_addresses',
  'primary_branch_only',
] as const;

export const command = 'ip-allow';
export const describe = 'Manage IP Allow';
export const builder = (argv: yargs.Argv) => {
  return argv
    .usage('$0 ip-allow <sub-command> [options]')
    .options({
      projectId: {
        describe: 'Project ID',
        type: 'string',
      },
    })
    .command(
      'list',
      'List IP Allow configuration',
      (yargs) => yargs,
      async (args) => {
        await list(args as any);
      },
    );
};

export const handler = (args: yargs.Argv) => {
  return args;
};

const list = async (props: CommonProps & ProjectScopeProps) => {
  const { data } = await props.apiClient.getProject(props.projectId);
  writer(props).end(parse(data.project), {
    fields: IP_ALLOW_FIELDS,
  });
};

const parse: (project: Project) => IPAllowFields = (project: Project) => {
  const ips = project.settings?.allowed_ips?.ips ?? [];
  return {
    id: project.id,
    name: project.name,
    IP_addresses: ips.join('\n'),
    primary_branch_only:
      project.settings?.allowed_ips?.primary_branch_only ?? false,
  };
};
