import yargs from 'yargs';
import { CommonProps } from '../../types.js';
import { writer } from '../../writer.js';
import prompts, { Choice, InitialReturnValue } from 'prompts';
import { validateNpmName } from './validate-pkg.js';
import { basename, resolve } from 'path';
import picocolors from 'picocolors';
import { isCi } from '../../env.js';
import { log } from '../../log.js';
import { existsSync, writeFileSync } from 'fs';
import { isFolderEmpty } from './is-folder-empty.js';
import { EndpointType, ProjectListItem } from '@neondatabase/api-client';
import { create } from '../projects.js';
import { execSync } from 'child_process';

export const command = 'create-app';
export const aliases = ['bootstrap'];
export const describe = 'Initialize a new Neon project';

export const builder = (yargs: yargs.Argv) =>
  yargs.option('context-file', {
    hidden: true,
  });

const onPromptState = (state: {
  value: InitialReturnValue;
  aborted: boolean;
  exited: boolean;
}) => {
  if (state.aborted) {
    // If we don't re-enable the terminal cursor before exiting
    // the program, the cursor will remain hidden
    process.stdout.write('\x1B[?25h');
    process.stdout.write('\n');
    process.exit(1);
  }
};

export const handler = async (args: CommonProps) => {
  await bootstrap(args);
};

const bootstrap = async (props: CommonProps) => {
  const out = writer(props);

  if (isCi()) {
    throw new Error('Cannot run interactive auth in CI');
  }

  const res = await prompts({
    onState: onPromptState,
    type: 'text',
    name: 'path',
    message: 'What is your project named?',
    initial: 'my-app',
    validate: (name) => {
      const validation = validateNpmName(basename(resolve(name)));
      if (validation.valid) {
        return true;
      }
      return 'Invalid project name: ' + validation.problems[0];
    },
  });

  let projectPath;
  if (typeof res.path === 'string') {
    projectPath = res.path.trim();
  } else {
    throw new Error('Could not get project path');
  }

  const resolvedProjectPath = resolve(projectPath);
  const projectName = basename(resolvedProjectPath);

  const validation = validateNpmName(projectName);
  if (!validation.valid) {
    throw new Error(
      `Could not create a project called ${picocolors.red(
        `"${projectName}"`,
      )} because of npm naming restrictions:`,
    );
  }

  /**
   * Verify the project dir is empty or doesn't exist
   */
  const root = resolve(resolvedProjectPath);
  const appName = basename(root);
  const folderExists = existsSync(root);

  if (folderExists && !isFolderEmpty(root, appName, out.text)) {
    throw new Error(
      `Could not create a project called ${picocolors.red(
        `"${projectName}"`,
      )} because the folder ${picocolors.red(
        `"${resolvedProjectPath}"`,
      )} is not empty.`,
    );
  }

  type BootstrapOptions = {
    auth?: 'auth.js';
    framework: 'Next.js' | 'SvelteKit' | 'Nuxt.js';
    deployment: 'vercel' | 'cloudflare';
    orm?: 'drizzle' | 'prisma';
    packageManager: 'npm' | 'pnpm' | 'bun' | 'yarn';
  };

  const defaultOptions: BootstrapOptions = {
    auth: 'auth.js',
    framework: 'Next.js',
    deployment: 'vercel',
    orm: 'drizzle',
    packageManager: 'npm',
  };

  const finalOptions: BootstrapOptions = {
    ...defaultOptions,
  };

  const packageManagerOptions: Array<Choice> = [
    {
      title: 'npm',
    },
    {
      title: 'pnpm',
    },
    {
      title: 'bun',
    },
    {
      title: 'yarn',
    },
  ];
  const { packageManagerOption } = await prompts({
    onState: onPromptState,
    type: 'select',
    name: 'packageManagerOption',
    message: `Which package manager would you like to use?`,
    choices: packageManagerOptions,
    initial: 0,
  });
  finalOptions.packageManager = packageManagerOptions[packageManagerOption]
    .title as typeof finalOptions.packageManager;

  const frameworkOptions: Array<Choice> = [
    {
      title: 'Next.js',
    },
    {
      title: 'SvelteKit',
      disabled: true,
    },
    {
      title: 'Nuxt.js',
      disabled: true,
    },
  ];
  const { framework } = await prompts({
    onState: onPromptState,
    type: 'select',
    name: 'framework',
    message: `What framework would you like to use?`,
    choices: frameworkOptions,
    initial: 0,
  });
  finalOptions.framework = frameworkOptions[framework]
    .title as typeof finalOptions.framework;

  const { deployment } = await prompts({
    onState: onPromptState,
    type: 'select',
    name: 'deployment',
    message: `Where would you like to deploy?`,
    choices: [{ title: 'Vercel' }, { title: 'Cloudflare', disabled: true }],
    initial: 0,
  });
  finalOptions.deployment = deployment;

  const { orm } = await prompts({
    onState: onPromptState,
    type: 'select',
    name: 'orm',
    message: `What ORM would you like to use?`,
    choices: [
      { title: 'Drizzle', value: 'drizzle' },
      { title: 'Prisma', value: 'prisma', disabled: true },
      { title: 'No ORM', value: -1, disabled: true },
    ],
    initial: 0,
  });
  finalOptions.orm = orm;

  const { auth } = await prompts({
    onState: onPromptState,
    type: 'select',
    name: 'auth',
    message: `What authentication framework do you want to use?`,
    choices: [
      { title: 'Auth.js', value: 'auth.js' },
      { title: 'No Authentication', value: -1 },
    ],
    initial: 0,
  });
  finalOptions.auth = auth;

  const PROJECTS_LIST_LIMIT = 100;
  const getList = async (
    fn:
      | typeof props.apiClient.listProjects
      | typeof props.apiClient.listSharedProjects,
  ) => {
    const result: ProjectListItem[] = [];
    let cursor: string | undefined;
    let end = false;
    while (!end) {
      const { data } = await fn({
        limit: PROJECTS_LIST_LIMIT,
        cursor,
      });
      result.push(...data.projects);
      cursor = data.pagination?.cursor;
      log.debug(
        'Got %d projects, with cursor: %s',
        data.projects.length,
        cursor,
      );
      if (data.projects.length < PROJECTS_LIST_LIMIT) {
        end = true;
      }
    }

    return result;
  };

  const [ownedProjects, sharedProjects] = await Promise.all([
    getList(props.apiClient.listProjects),
    getList(props.apiClient.listSharedProjects),
  ]);
  const allProjects = [...ownedProjects, ...sharedProjects];

  const projectChoices = [
    { title: 'Create a new Neon project', value: -1 },
    ...allProjects.map((project) => {
      return {
        title: project.name,
        value: project.id,
      };
    }),
  ];

  // `neonProject` will either be -1 or a string (project ID)
  const { neonProject } = await prompts({
    onState: onPromptState,
    type: 'select',
    name: 'neonProject',
    message: `What Neon project would you like to use?`,
    choices: projectChoices,
    initial: 0,
  });

  let project;
  let connectionString: string;
  if (neonProject === -1) {
    project = await create({ ...props, psql: false, setContext: false });
    connectionString = project.connection_uris[0].connection_uri;
  } else {
    project = allProjects.find((p) => p.id === neonProject);

    if (!project) {
      throw new Error(
        'An unexpected error occured while selecting the Neon project to use.',
      );
    }

    const {
      data: { branches },
    } = await props.apiClient.listProjectBranches(project.id);

    let branchId;
    if (branches.length === 0) {
      throw new Error(`No branches found for the project ${project.name}.`);
    } else if (branches.length === 1) {
      branchId = branches[0].id;
    } else {
      const branchChoices = branches.map((branch) => {
        return {
          title: branch.name,
          value: branch.id,
        };
      });

      const { branchIdChoice } = await prompts({
        onState: onPromptState,
        type: 'select',
        name: 'branchIdChoice',
        message: `What branch would you like to use?`,
        choices: branchChoices,
        initial: 0,
      });
      branchId = branchIdChoice;
    }

    const {
      data: { endpoints },
    } = await props.apiClient.listProjectBranchEndpoints(project.id, branchId);
    const endpoint = endpoints.find((e) => e.type === EndpointType.ReadWrite);
    if (!endpoint) {
      throw new Error(
        `No read-write endpoint found for the project ${project.name}.`,
      );
    }

    const {
      data: { roles },
    } = await props.apiClient.listProjectBranchRoles(project.id, branchId);
    let role;
    if (roles.length === 0) {
      throw new Error(`No roles found for the branch: ${branchId}`);
    } else if (roles.length === 1) {
      role = roles[0];
    } else {
      const roleChoices = roles.map((r) => {
        return {
          title: r.name,
          value: r.name,
        };
      });

      const { roleName } = await prompts({
        onState: onPromptState,
        type: 'select',
        name: 'roleName',
        message: `What role would you like to use?`,
        choices: roleChoices,
        initial: 0,
      });
      role = roles.find((r) => r.name === roleName);
      if (!role) {
        throw new Error(`No role found for the name: ${roleName}`);
      }
    }

    const {
      data: { databases: branchDatabases },
    } = await props.apiClient.listProjectBranchDatabases(project.id, branchId);
    let database;
    if (branchDatabases.length === 0) {
      throw new Error(`No databases found for the branch: ${branchId}`);
    } else if (branchDatabases.length === 1) {
      database = branchDatabases[0];
    } else {
      const databaseChoices = branchDatabases.map((db) => {
        return {
          title: db.name,
          value: db.id,
        };
      });

      const { databaseId } = await prompts({
        onState: onPromptState,
        type: 'select',
        name: 'databaseId',
        message: `What database would you like to use?`,
        choices: databaseChoices,
        initial: 0,
      });
      database = branchDatabases.find((d) => d.id === databaseId);
      if (!database) {
        throw new Error(`No database found with ID: ${databaseId}`);
      }
    }

    const {
      data: { password },
    } = await props.apiClient.getProjectBranchRolePassword(
      project.id,
      endpoint.branch_id,
      role.name,
    );

    const host = endpoint.host;
    const connectionUrl = new URL(`postgresql://${host}`);
    connectionUrl.pathname = database.name;
    connectionUrl.username = role.name;
    connectionUrl.password = password;
    connectionString = connectionUrl.toString();
  }

  if (finalOptions.framework === 'Next.js') {
    let template;
    if (finalOptions.auth === 'auth.js') {
      template =
        'https://github.com/neondatabase/neonctl/tree/bootstrap-command/src/commands/bootstrap/next-drizzle-authjs';
    } else {
      template =
        'https://github.com/neondatabase/neonctl/tree/bootstrap-command/src/commands/bootstrap/next-drizzle';
    }

    let packageManager = '--use-npm';
    if (finalOptions.packageManager === 'yarn') {
      packageManager = '--use-yarn';
    } else if (finalOptions.packageManager === 'bun') {
      packageManager = '--use-bun';
    } else if (finalOptions.packageManager === 'pnpm') {
      packageManager = '--use-pnpm';
    }

    try {
      execSync(
        `npx create-next-app \
            ${packageManager} \
            --example ${template} \
            ${appName} \
          `,
        { stdio: 'inherit' },
      );
    } catch (error: unknown) {
      throw new Error(`Creating a Next.js project failed: ${error}.`);
    }

    if (finalOptions.auth === 'auth.js') {
      // Generate AUTH_SECRET using openssl
      const authSecret = execSync('openssl rand -base64 33').toString().trim();

      // Content for the .env.local file
      const content = `DATABASE_URL=${connectionString}
AUTH_SECRET=${authSecret}`;

      // Write the content to the .env.local file
      writeFileSync(`${appName}/.env.local`, content, 'utf8');
    } else {
      // Content for the .env.local file
      const content = `DATABASE_URL=${connectionString}`;

      // Write the content to the .env.local file
      writeFileSync(`${appName}/.env.local`, content, 'utf8');
    }

    out.text(
      `Created a Next.js project in ${picocolors.blue(
        appName,
      )}.\n\nYou can now run ${picocolors.blue(
        `cd ${appName} && npm run dev`,
      )}`,
    );
  }

  if (finalOptions.orm === 'drizzle') {
    try {
      execSync('npm run db:generate -- --name init_db', {
        cwd: appName,
        stdio: 'inherit',
      });
    } catch (error) {
      throw new Error(`Generating the database schema failed: ${error}.`);
    }

    try {
      execSync('npm run db:migrate', { cwd: appName, stdio: 'inherit' });
    } catch (error) {
      throw new Error(`Applying the schema failed: ${error}.`);
    }

    out.text(`Database schema generated and applied.\n`);
  }
};
