import { ProjectCreateRequest } from '@neondatabase/api-client';
import yargs from 'yargs';
import { projectCreateRequest } from '../parameters.gen';
import { CommonProps } from '../types';
import { showHelpMiddleware } from '../utils';
import { writeOut } from '../writer';

const PROJECT_FIELDS = ['id', 'name', 'region_id', 'created_at'] as const;

export const command = 'projects <command>';
export const describe = 'Manage projects';
export const builder = (yargs: yargs.Argv) =>
  yargs
    .usage('usage: $0 projects <cmd> [args]')
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
    .middleware(showHelpMiddleware);

const list = async (props: CommonProps) => {
  writeOut(props)((await props.apiClient.listProjects({})).data.projects, {
    fields: PROJECT_FIELDS,
  });
};

const create = async (props: CommonProps & ProjectCreateRequest) => {
  writeOut(props)(
    (
      await props.apiClient.createProject({
        project: props.project,
      })
    ).data.project,
    { fields: PROJECT_FIELDS }
  );
};

const deleteProject = async (
  props: CommonProps & { project: { id: string } }
) => {
  writeOut(props)(
    (await props.apiClient.deleteProject(props.project.id)).data.project,
    {
      fields: PROJECT_FIELDS,
    }
  );
};

const update = async (
  props: CommonProps & { project: { id: string } } & ProjectCreateRequest
) => {
  writeOut(props)(
    (
      await props.apiClient.updateProject(props.project.id, {
        project: props.project,
      })
    ).data.project,
    { fields: PROJECT_FIELDS }
  );
};
