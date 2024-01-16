import yargs from 'yargs';
import { CommonProps, ProjectScopeProps } from '../types';
import { writer } from '../writer.js';
import { Project, ProjectUpdateRequest } from '@neondatabase/api-client';
import { projectUpdateRequest } from '../parameters.gen.js';
import { log } from '../log.js';

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
      'project-id': {
        describe: 'Project ID',
        type: 'string',
        demandOption: true,
      },
    })
    .command(
      'list',
      'List IP Allow configuration',
      (yargs) => yargs,
      async (args) => {
        await list(args as any);
      },
    )
    .command(
      'add [ips...]',
      'Add IP addresses to IP Allow configuration',
      (yargs) =>
        yargs
          .usage('$0 ip-allow add [ips...]')
          .positional('ips', {
            describe: 'The list of IP Addresses to add',
            type: 'string',
            default: [],
            array: true,
          })
          .options({
            'primary-only': {
              describe:
                projectUpdateRequest[
                  'project.settings.allowed_ips.primary_branch_only'
                ].description,
              type: 'boolean',
            },
          }),
      async (args) => {
        await add(args as any);
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

const add = async (
  props: CommonProps &
    ProjectScopeProps & {
      ips: string[];
      primaryOnly?: boolean;
    },
) => {
  if (props.ips.length <= 0) {
    log.error(`Enter individual IP addresses, define ranges with a dash, or use CIDR notation for more flexibility.
       Example: neonctl ip-allow add 192.168.1.1, 192.168.1.20-192.168.1.50, 192.168.1.0/24 --projectId <projectId>`);
    return;
  }

  const project: ProjectUpdateRequest['project'] = {};
  const { data } = await props.apiClient.getProject(props.projectId);
  const existingAllowedIps = data.project.settings?.allowed_ips;

  project.settings = {
    allowed_ips: {
      ips: [...new Set(props.ips.concat(existingAllowedIps?.ips ?? []))],
      primary_branch_only:
        props.primaryOnly ?? existingAllowedIps?.primary_branch_only ?? false,
    },
  };

  const { data: response } = await props.apiClient.updateProject(
    props.projectId,
    {
      project,
    },
  );

  writer(props).end(parse(response.project), {
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
