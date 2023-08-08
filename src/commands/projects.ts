import {
  ProjectCreateRequest,
  ProjectListItem,
} from '@neondatabase/api-client';
import yargs from 'yargs';

import { showHelpMiddleware } from '../help.js';
import { log } from '../log.js';
import { projectCreateRequest } from '../parameters.gen.js';
import { CommonProps, IdOrNameProps } from '../types.js';
import { writer } from '../writer.js';
import { psql, psqlArgs } from '../utils/psql.js';

const PROJECT_FIELDS = ['id', 'name', 'region_id', 'created_at'] as const;

const REGIONS = [
  'aws-us-west-2',
  'aws-ap-southeast-1',
  'aws-eu-central-1',
  'aws-us-east-2',
  'aws-us-east-1',
];

const PROJECTS_LIST_LIMIT = 100;

export const command = 'projects';
export const describe = 'Manage projects';
export const aliases = ['project'];
export const builder = (argv: yargs.Argv) => {
  return argv
    .usage('$0 projects <sub-command> [options]')
    .middleware(showHelpMiddleware(argv))
    .command(
      'list',
      'List projects',
      (yargs) => yargs,
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
          psql: {
            type: 'boolean',
            describe: 'Connect to a new project via psql',
            default: false,
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

  if (props.psql) {
    const connection_uri = data.connection_uris[0].connection_uri;
    await psql(connection_uri, psqlArgs(process.argv));
  } else {
    const out = writer(props);
    out.write(data.project, { fields: PROJECT_FIELDS, title: 'Project' });
    out.write(data.connection_uris, {
      fields: ['connection_uri'],
      title: 'Connection URIs',
    });
    out.end();
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
