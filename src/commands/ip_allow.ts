import yargs from 'yargs';
import { CommonProps, ProjectScopeProps } from '../types';
import { writer } from '../writer.js';
import { fillSingleProject } from '../utils/enrichers.js';
import { Project, ProjectUpdateRequest } from '@neondatabase/api-client';
import { projectUpdateRequest } from '../parameters.gen.js';
import { log } from '../log.js';

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
      },
    })
    .middleware(fillSingleProject as any)
    .command(
      'list',
      'List the IP allowlist',
      (yargs) => yargs,
      async (args) => {
        await list(args as any);
      },
    )
    .command(
      'add [ips...]',
      'Add IP addresses to the IP allowlist',
      (yargs) =>
        yargs
          .usage('$0 ip-allow add [ips...]')
          .positional('ips', {
            describe: 'The list of IP addresses to add',
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
    )
    .command(
      'remove [ips...]',
      'Remove IP addresses from the IP allowlist',
      (yargs) =>
        yargs.usage('$0 ip-allow remove [ips...]').positional('ips', {
          describe: 'The list of IP addresses to remove',
          type: 'string',
          default: [],
          array: true,
        }),
      async (args) => {
        await remove(args as any);
      },
    )
    .command(
      'reset [ips...]',
      'Reset the IP allowlist',
      (yargs) =>
        yargs.usage('$0 ip-allow reset [ips...]').positional('ips', {
          describe: 'The list of IP addresses to reset',
          type: 'string',
          default: [],
          array: true,
        }),
      async (args) => {
        await reset(args as any);
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
       Example: neonctl ip-allow add 192.168.1.1, 192.168.1.20-192.168.1.50, 192.168.1.0/24 --project-id <id>`);
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

const remove = async (props: ProjectScopeProps & { ips: string[] }) => {
  if (props.ips.length <= 0) {
    log.error(
      `Remove individual IP addresses and ranges. Example: neonctl ip-allow remove 192.168.1.1 --project-id <id>`,
    );
    return;
  }

  const project: ProjectUpdateRequest['project'] = {};
  const { data } = await props.apiClient.getProject(props.projectId);
  const existingAllowedIps = data.project.settings?.allowed_ips;

  project.settings = {
    allowed_ips: {
      ips:
        existingAllowedIps?.ips.filter((ip) => !props.ips.includes(ip)) ?? [],
      primary_branch_only: existingAllowedIps?.primary_branch_only ?? false,
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

const reset = async (props: ProjectScopeProps & { ips: string[] }) => {
  const project: ProjectUpdateRequest['project'] = {};
  project.settings = {
    allowed_ips: {
      ips: props.ips,
      primary_branch_only: false,
    },
  };

  const { data } = await props.apiClient.updateProject(props.projectId, {
    project,
  });

  writer(props).end(parse(data.project), {
    fields: IP_ALLOW_FIELDS,
  });

  if (props.ips.length <= 0) {
    log.info(
      `The IP allowlist has been reset. All databases on project "${data.project.name}" are now exposed to the internet`,
    );
  }
};

const parse = (project: Project) => {
  const ips = project.settings?.allowed_ips?.ips ?? [];
  return {
    id: project.id,
    name: project.name,
    IP_addresses: ips,
    primary_branch_only:
      project.settings?.allowed_ips?.primary_branch_only ?? false,
  };
};
