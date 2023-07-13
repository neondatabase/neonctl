import { ProjectCreateRequest } from '@neondatabase/api-client';
import yargs from 'yargs';

import { projectCreateRequest } from '../parameters.gen.js';
import { CommonProps, IdOrNameProps } from '../types.js';
import { commandFailHandler } from '../utils/middlewares.js';
import { writer } from '../writer.js';

const PROJECT_FIELDS = ['id', 'name', 'region_id', 'created_at'] as const;

const REGIONS = [
  'aws-us-west-2',
  'aws-ap-southeast-1',
  'aws-eu-central-1',
  'aws-us-east-2',
  'aws-us-east-1',
];

export const command = 'projects';
export const describe = 'Manage projects';
export const aliases = ['project'];
export const builder = (argv: yargs.Argv) => {
  return argv
    .demandCommand(1, '')
    .fail(commandFailHandler)
    .usage('usage: $0 projects <sub-command> [options]')
    .command(
      'list',
      'List projects',
      (yargs) =>
        yargs.options({
          limit: {
            type: 'number',
            describe: 'Limit the number of projects returned',
            default: 100,
          },
        }),
      async (args) => {
        await list(args as any);
      }
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
        }),
      async (args) => {
        await create(args as any);
      }
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
        }),
      async (args) => {
        await update(args as any);
      }
    )
    .command(
      'delete <id>',
      'Delete a project',
      (yargs) => yargs,
      async (args) => {
        await deleteProject(args as any);
      }
    )
    .command(
      'get <id>',
      'Get a project',
      (yargs) => yargs,
      async (args) => {
        await get(args as any);
      }
    );
};
export const handler = (args: yargs.Argv) => {
  return args;
};

const list = async (props: CommonProps & { limit: number }) => {
  const { data } = await props.apiClient.listProjects({
    limit: props.limit,
  });
  writer(props).end(data.projects, { fields: PROJECT_FIELDS });
};

const create = async (
  props: CommonProps & {
    name?: string;
    regionId?: string;
  }
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
  const out = writer(props);
  out.write(data.project, { fields: PROJECT_FIELDS });
  out.write(data.connection_uris, { fields: ['connection_uri'] });
  out.end();
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
      name: string;
    }
) => {
  const { data } = await props.apiClient.updateProject(props.id, {
    project: {
      name: props.name,
    },
  });
  writer(props).end(data.project, { fields: PROJECT_FIELDS });
};

const get = async (props: CommonProps & IdOrNameProps) => {
  const { data } = await props.apiClient.getProject(props.id);
  writer(props).end(data.project, { fields: PROJECT_FIELDS });
};
