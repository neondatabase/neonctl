import {
  ProjectCreateRequest,
  ProjectListItem,
  ProjectUpdateRequest,
} from '@neondatabase/api-client';
import yargs from 'yargs';

import { log } from '../log.js';
import {
  projectCreateRequest,
  projectUpdateRequest,
} from '../parameters.gen.js';
import { CommonProps, IdOrNameProps } from '../types.js';
import { writer } from '../writer.js';
import { psql } from '../utils/psql.js';
import { updateContextFile } from '../context.js';

const PROJECT_FIELDS = ['id', 'name', 'region_id', 'created_at'] as const;

const REGIONS = [
  'aws-us-west-2',
  'aws-ap-southeast-1',
  'aws-eu-central-1',
  'aws-us-east-2',
  'aws-us-east-1',
  'aws-il-central-1',
];

const PROJECTS_LIST_LIMIT = 100;

export const command = 'projects';
export const describe = 'Manage projects';
export const aliases = ['project'];
export const builder = (argv: yargs.Argv) => {
  return argv
    .usage('$0 projects <sub-command> [options]')
    .command(
      'list',
      'List projects',
      (yargs) => yargs,
      async (args) => {
        await list(args as any);
      },
    )
    .command(
      'create',
      'Create a project',
      (yargs) =>
        yargs.options({
          name: {
            describe: projectCreateRequest['project.name'].description,
            type: 'string',
          },
          'region-id': {
            describe: `The region ID. Possible values: ${REGIONS.join(', ')}`,
            type: 'string',
          },
          psql: {
            type: 'boolean',
            describe: 'Connect to a new project via psql',
            default: false,
          },
          'set-context': {
            type: 'boolean',
            describe: 'Set the current context to the new project',
            default: false,
          },
        }),
      async (args) => {
        await create(args as any);
      },
    )
    .command(
      'update <id>',
      'Update a project',
      (yargs) =>
        yargs.options({
          name: {
            describe: projectCreateRequest['project.name'].description,
            type: 'string',
          },
          ipAllowIps: {
            describe:
              projectUpdateRequest['project.settings.allowed_ips.ips']
                .description ??
              'A list of IP addresses that are allowed to connect to the endpoint.',
            type: 'string',
            array: true,
            group: 'IP Allow:',
          },
          ipAllowPrimaryBranchOnly: {
            describe:
              projectUpdateRequest[
                'project.settings.allowed_ips.primary_branch_only'
              ].description ??
              'If set true, the list will be applied only to the primary branch.',
            type: 'boolean',
            group: 'IP Allow:',
          },
        }),
      async (args) => {
        await update(args as any);
      },
    )
    .command(
      'delete <id>',
      'Delete a project',
      (yargs) => yargs,
      async (args) => {
        await deleteProject(args as any);
      },
    )
    .command(
      'get <id>',
      'Get a project',
      (yargs) => yargs,
      async (args) => {
        await get(args as any);
      },
    );
};
export const handler = (args: yargs.Argv) => {
  return args;
};

const list = async (props: CommonProps) => {
  const result: ProjectListItem[] = [];
  let cursor: string | undefined;
  let end = false;
  while (!end) {
    const { data } = await props.apiClient.listProjects({
      limit: PROJECTS_LIST_LIMIT,
      cursor,
    });
    result.push(...data.projects);
    cursor = data.pagination?.cursor;
    log.debug('Got %d projects, with cursor: %s', data.projects.length, cursor);
    if (data.projects.length < PROJECTS_LIST_LIMIT) {
      end = true;
    }
  }
  writer(props).end(result, { fields: PROJECT_FIELDS });
};

const create = async (
  props: CommonProps & {
    name?: string;
    regionId?: string;
    psql: boolean;
    setContext: boolean;
    '--'?: string[];
  },
) => {
  const project: ProjectCreateRequest['project'] = {};
  if (props.name) {
    project.name = props.name;
  }
  if (props.regionId) {
    project.region_id = props.regionId;
  }
  const { data } = await props.apiClient.createProject({
    project,
  });

  if (props.setContext) {
    updateContextFile(props.contextFile, {
      projectId: data.project.id,
      branchId: data.branch.id,
    });
  }

  const out = writer(props);
  out.write(data.project, { fields: PROJECT_FIELDS, title: 'Project' });
  out.write(data.connection_uris, {
    fields: ['connection_uri'],
    title: 'Connection URIs',
  });
  out.end();

  if (props.psql) {
    const connection_uri = data.connection_uris[0].connection_uri;
    const psqlArgs = props['--'];
    await psql(connection_uri, psqlArgs);
  }
};

const deleteProject = async (props: CommonProps & IdOrNameProps) => {
  const { data } = await props.apiClient.deleteProject(props.id);
  writer(props).end(data.project, {
    fields: PROJECT_FIELDS,
  });
};

const update = async (
  props: CommonProps &
    IdOrNameProps & {
      name?: string;
      ipAllowIps?: string[];
      ipAllowPrimaryBranchOnly?: boolean;
    },
) => {
  const project: ProjectUpdateRequest['project'] = {};
  if (props.name) {
    project.name = props.name;
  }
  if (props.ipAllowIps) {
    project.settings = {
      allowed_ips: {
        ips: props.ipAllowIps,
        primary_branch_only: props.ipAllowPrimaryBranchOnly ?? false,
      },
    };
  } else if (props.ipAllowPrimaryBranchOnly) {
    project.settings = {
      allowed_ips: {
        ips: [],
        primary_branch_only: props.ipAllowPrimaryBranchOnly ?? false,
      },
    };
  }

  const { data } = await props.apiClient.updateProject(props.id, {
    project,
  });
  writer(props).end(data.project, { fields: PROJECT_FIELDS });
};

const get = async (props: CommonProps & IdOrNameProps) => {
  const { data } = await props.apiClient.getProject(props.id);
  writer(props).end(data.project, { fields: PROJECT_FIELDS });
};
