import yargs from 'yargs';

import { CommonProps, IdOrNameProps } from '../types.js';
import { writer } from '../writer.js';
import { log } from '../log.js';
import path from 'path';
import fs from 'fs';

import Mustache from 'mustache';

import { projectCreateRequest } from '../parameters.gen.js';

import { create as createProject } from '../commands/projects.js';

import {
  downloadFolderFromTree,
  getContent,
  getFileContent,
} from '../utils/github.js';

const TEMPLATE_LIST_FIELDS = ['name'] as const;

const REPOSITORY_OWNER = 'neon-scaffolder';
const REPOSITORY = 'templates';

const GENERATED_FOLDER_PREFIX = 'neon-';

// TODO: Maybe move to constants file?
const REGIONS = [
  'aws-us-west-2',
  'aws-ap-southeast-1',
  'aws-eu-central-1',
  'aws-us-east-2',
  'aws-us-east-1',
];

export const command = 'scaffold';
export const describe = 'Create new project from selected template';
export const aliases = ['scaffold'];
export const builder = (argv: yargs.Argv) => {
  return argv
    .usage('$0 scaffold [options]')
    .command(
      'list',
      'List available templates',
      (yargs) => yargs,
      async (args) => {
        // @ts-expect-error: TODO - Assert `args` is `CommonProps`
        await list(args);
      },
    )
    .command(
      'start <id>',
      'Create new project from selected template',
      (yargs) =>
        yargs.options({
          'project-id': {
            describe:
              'ID of existing project. If not set, new project will be created',
            type: 'string',
          },
          name: {
            describe: projectCreateRequest['project.name'].description,
            type: 'string',
          },
          'output-dir': {
            describe: 'Output directory',
            type: 'string',
          },
          'region-id': {
            describe: `The region ID. Possible values: ${REGIONS.join(', ')}`,
            type: 'string',
          },
          'org-id': {
            describe: "The project's organization ID",
            type: 'string',
          },
          psql: {
            type: 'boolean',
            describe: 'Connect to a new project via psql',
            default: false,
          },
          database: {
            describe:
              projectCreateRequest['project.branch.database_name'].description,
            type: 'string',
          },
          role: {
            describe:
              projectCreateRequest['project.branch.role_name'].description,
            type: 'string',
          },
          'set-context': {
            type: 'boolean',
            describe: 'Set the current context to the new project',
            default: false,
          },
          cu: {
            describe:
              'The number of Compute Units. Could be a fixed size (e.g. "2") or a range delimited by a dash (e.g. "0.5-3").',
            type: 'string',
          },
        }),
      async (args) => {
        // @ts-expect-error: TODO - Assert `args` is `CommonProps`
        await start(args);
      },
    );
};
export const handler = (args: yargs.Argv) => {
  return args;
};

async function getTemplateList() {
  const content = await getContent(REPOSITORY_OWNER, REPOSITORY);

  return content
    .filter((el: any) => el.type === 'dir')
    .map((el: any) => ({ name: el.name }));
}

const list = async (props: CommonProps) => {
  const out = writer(props);

  out.write(await getTemplateList(), {
    fields: TEMPLATE_LIST_FIELDS,
    title: 'Templates',
  });
  out.end();
};

const start = async (
  props: CommonProps &
    IdOrNameProps & {
      id: string;
      projectId?: string;
      outputDir?: string;
      name?: string;
      regionId?: string;
      cu?: string;
      orgId?: string;
      database?: string;
      role?: string;
      psql: boolean;
      setContext: boolean;
      '--'?: string[];
    },
) => {
  const availableTemplates = (await getTemplateList()).map(
    (el: any) => el.name,
  );
  if (!availableTemplates.includes(props.id)) {
    log.error(
      'Template not found. Please make sure the template exists and is public.',
    );
    return;
  }
  let projectData: any;
  if (!props.projectId) {
    projectData = await createProject(props);
  } else {
    projectData = (await props.apiClient.getProject(props.projectId)).data;
    const branches: any = (
      await props.apiClient.listProjectBranches(props.projectId)
    ).data.branches;
    const roles: any = (
      await props.apiClient.listProjectBranchRoles(
        props.projectId,
        branches[0].id,
      )
    ).data.roles;

    const connectionString: any = (
      await props.apiClient.getConnectionUri({
        projectId: props.projectId,
        database_name: branches[0].name,
        role_name: roles[0].name,
      })
    ).data.uri;
    const connectionUrl = new URL(connectionString);

    projectData.connection_uris = [
      {
        connection_uri: connectionString,
        connection_parameters: {
          database: projectData.project.name,
          role: roles[0].name,
          password: connectionUrl.password,
          host: connectionUrl.host,
        },
      },
    ];
  }

  let config = null;
  try {
    config = await (
      await getFileContent(
        REPOSITORY_OWNER,
        REPOSITORY,
        props.id + '/config.neon.json',
      )
    ).json();
  } catch (e) {
    log.error(
      "Couldn't fetch template config file. Please make sure the template exists and is public.",
    );
    log.error(e);
    return;
  }

  const dir = path.join(
    process.cwd(),
    props.outputDir
      ? props.outputDir
      : GENERATED_FOLDER_PREFIX + (projectData.project.name as string),
  );
  await downloadFolderFromTree(
    REPOSITORY_OWNER,
    REPOSITORY,
    'main',
    props.id,
    dir,
  );

  for (const [key, value] of Object.entries(config.copy_files)) {
    copyFiles(dir, key, value);
  }

  for (const file of config.templated_files) {
    const content = fs.readFileSync(path.join(dir, file), {
      encoding: 'utf-8',
    });

    const output = Mustache.render(content, projectData);
    fs.writeFileSync(path.join(dir, file), output);
  }

  const out = writer(props);

  out.write(
    [{ name: projectData.project.name, template: props.id, path: dir }],
    {
      fields: ['name', 'template', 'path'],
      title: 'Created projects',
    },
  );
  out.end();
};

function copyFiles(prefix: string, sourceFile: string, targetFiles: any) {
  for (const targetFile of targetFiles) {
    const sourcePath = path.join(prefix, sourceFile);
    const targetPath = path.join(prefix, targetFile);
    fs.copyFileSync(sourcePath, targetPath);
  }
}
