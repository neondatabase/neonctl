import { ProjectCreateRequest } from '@neondatabase/api-client';
import yargs from 'yargs';

import { projectCreateRequest } from '../parameters.gen.js';
import { CommonProps } from '../types.js';
import { commandFailHandler } from '../utils.js';
import { writer } from '../writer.js';

const PROJECT_FIELDS = ['id', 'name', 'region_id', 'created_at'] as const;

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
      (yargs) => yargs,
      async (args) => {
        await list(args as any);
      }
    )
    .command(
      'create',
      'Create a project',
      (yargs) => yargs.options(projectCreateRequest),
      async (args) => {
        await create(args as any);
      }
    )
    .command(
      'update',
      'Update a project',
      (yargs) =>
        yargs
          .option('project.id', {
            describe: 'Project ID',
            type: 'string',
            demandOption: true,
          })
          .options(projectCreateRequest),
      async (args) => {
        await update(args as any);
      }
    )
    .command(
      'delete',
      'Delete a project',
      (yargs) =>
        yargs.options({
          'project.id': {
            describe: 'Project ID',
            type: 'string',
            demandOption: true,
          },
        }),
      async (args) => {
        await deleteProject(args as any);
      }
    )
    .command(
      'get',
      'Get a project',
      (yargs) =>
        yargs.options({
          'project.id': {
            describe: 'Project ID',
            type: 'string',
            demandOption: true,
          },
        }),
      async (args) => {
        await get(args as any);
      }
    );
};
export const handler = (args: yargs.Argv) => {
  return args;
};

const list = async (props: CommonProps) => {
  const { data } = await props.apiClient.listProjects({});
  writer(props).end(data.projects, { fields: PROJECT_FIELDS });
};

const create = async (props: CommonProps & ProjectCreateRequest) => {
  if (props.project == null) {
    props.project = {};
    const inquirer = await import('inquirer');
    const answers = await inquirer.default.prompt([
      { name: 'name', message: 'Project name (optional)', type: 'input' },
    ] as const);
    if (answers.name) {
      props.project = answers;
    }
  }
  const { data } = await props.apiClient.createProject({
    project: props.project,
  });
  writer(props).end(data.project, { fields: PROJECT_FIELDS });
};

const deleteProject = async (
  props: CommonProps & { project: { id: string } }
) => {
  const { data } = await props.apiClient.deleteProject(props.project.id);
  writer(props).end(data.project, {
    fields: PROJECT_FIELDS,
  });
};

const update = async (
  props: CommonProps & { project: { id: string } } & ProjectCreateRequest
) => {
  const { data } = await props.apiClient.updateProject(props.project.id, {
    project: props.project,
  });
  writer(props).end(data.project, { fields: PROJECT_FIELDS });
};

const get = async (props: CommonProps & { project: { id: string } }) => {
  const { data } = await props.apiClient.getProject(props.project.id);
  writer(props).end(data.project, { fields: PROJECT_FIELDS });
};
