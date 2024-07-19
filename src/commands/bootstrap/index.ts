import yargs from 'yargs';
import { CommonProps } from '../../types.js';
import { writer } from '../../writer.js';
import prompts, { Choice, InitialReturnValue } from 'prompts';
import { validateNpmName } from './validate-pkg.js';
import { basename, resolve } from 'path';
import chalk from 'chalk';
import { isCi } from '../../env.js';
import { log } from '../../log.js';
import { existsSync, writeFileSync } from 'fs';
import { isFolderEmpty } from './is-folder-empty.js';
import {
  EndpointType,
  ProjectListItem,
  ProjectCreateRequest,
} from '@neondatabase/api-client';
import { PROJECT_FIELDS } from '../projects.js';
import { execSync } from 'child_process';
import { trackEvent } from '../../analytics.js';

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

type BootstrapOptions = {
  auth?: 'auth.js';
  framework: 'Next.js' | 'SvelteKit' | 'Nuxt.js';
  deployment: 'vercel' | 'cloudflare';
  orm?: 'drizzle' | 'prisma';

  packageManager: 'npm' | 'pnpm' | 'bun';
};

// `getCreateNextAppCommand` returns the command for creating a Next app
// with `create-next-app` for different package managers.
function getCreateNextAppCommand(
  packageManager: BootstrapOptions['packageManager'],
) {
  const createNextAppVersion = '14.2.4';

  switch (packageManager) {
    case 'npm':
      return `npx create-next-app@${createNextAppVersion}`;
    case 'bun':
      return `bunx create-next-app@${createNextAppVersion}`;
    case 'pnpm':
      return `pnpm create next-app@${createNextAppVersion}`;
  }
}

function getExecutorProgram(
  packageManager: BootstrapOptions['packageManager'],
) {
  switch (packageManager) {
    case 'npm':
      return 'npx';
    case 'pnpm':
      return 'pnpx';
    case 'bun':
      return 'bunx';
  }
}

type EnvironmentVariable = {
  kind: 'build' | 'runtime';
  key: string;
  value: string;
};

function writeEnvFile({
  fileName,
  secrets,
}: {
  fileName: string;
  secrets: EnvironmentVariable[];
}) {
  let content = '';
  for (const secret of secrets) {
    content += `${secret.key}=${secret.value}\n`;
  }

  writeFileSync(fileName, content, 'utf8');
}

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
    validate: (name: string) => {
      // We resolve to normalize the path name first, so that if the user enters
      // something like "/hello", we get back just "hello" and not "/hello".
      // This avoids issues where relative paths might lead to different results
      // depending on the current working directory. It also prevents issues
      // related to invalid symlinks.
      const validation = validateNpmName(basename(resolve(name)));
      if (validation.valid) {
        return true;
      }
      return 'Invalid project name: ' + validation.problems[0];
    },
  });
  trackEvent('create-app', { phase: 'start' });

  if (typeof res.path !== 'string') {
    throw new Error('Could not get project path');
  }

  // We resolve to normalize the path name first, so that if the user enters
  // something like "/hello", we get back just "hello" and not "/hello".
  // This avoids issues where relative paths might lead to different results
  // depending on the current working directory. It also prevents issues
  // related to invalid symlinks.
  const projectPath = res.path.trim();
  const resolvedProjectPath = resolve(projectPath);
  const projectName = basename(resolvedProjectPath);

  const validation = validateNpmName(projectName);
  if (!validation.valid) {
    throw new Error(
      `Could not create a project called ${chalk.red(
        `"${projectName}"`,
      )} because of npm package naming restrictions:`,
    );
  }

  /**
   * Verify the project dir is empty or doesn't exist
   */
  const root = resolve(resolvedProjectPath);
  const appName = basename(root);
  const folderExists = existsSync(root);

  if (folderExists && !isFolderEmpty(root, appName, (data) => out.text(data))) {
    throw new Error(
      `Could not create a project called ${chalk.red(
        `"${projectName}"`,
      )} because the folder ${chalk.red(
        `"${resolvedProjectPath}"`,
      )} is not empty.`,
    );
  }

  const finalOptions: BootstrapOptions = {
    auth: 'auth.js',
    framework: 'Next.js',
    deployment: 'vercel',
    orm: 'drizzle',
    packageManager: 'npm',
  };

  const packageManagerOptions: Choice[] = [
    {
      title: 'npm',
    },
    {
      title: 'pnpm',
    },
    {
      title: 'bun',
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
    .title as BootstrapOptions['packageManager'];
  trackEvent('create-app', {
    phase: 'package-manager',
    meta: { packageManager: finalOptions.packageManager },
  });

  const frameworkOptions: Choice[] = [
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
    warn: 'Coming soon',
  });
  finalOptions.framework = frameworkOptions[framework]
    .title as BootstrapOptions['framework'];
  trackEvent('create-app', {
    phase: 'framework',
    meta: { framework: finalOptions.framework },
  });

  const { orm } = await prompts({
    onState: onPromptState,
    type: 'select',
    name: 'orm',
    message: `What ORM would you like to use?`,
    choices: [
      { title: 'Drizzle', value: 'drizzle' },
      { title: 'Prisma', value: 'prisma' },
      { title: 'No ORM', value: -1, disabled: true },
    ],
    initial: 0,
    warn: 'Coming soon',
  });
  finalOptions.orm = orm;
  trackEvent('create-app', { phase: 'orm', meta: { orm: finalOptions.orm } });

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
  finalOptions.auth = auth === -1 ? undefined : auth;
  trackEvent('create-app', {
    phase: 'auth',
    meta: { auth: finalOptions.auth },
  });

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
  trackEvent('create-app', { phase: 'neon-project' });

  let projectCreateRequest: ProjectCreateRequest['project'];
  let project;
  let connectionString: string;
  if (neonProject === -1) {
    try {
      // Call the API directly. This code is inspired from the `create` code in
      // `projects.ts`.
      projectCreateRequest = {
        name: `${appName}-db`,
        branch: {},
      };

      const { data } = await props.apiClient.createProject({
        project: projectCreateRequest,
      });
      project = data.project;

      const out = writer(props);
      out.write(project, { fields: PROJECT_FIELDS, title: 'Project' });
      out.write(data.connection_uris, {
        fields: ['connection_uri'],
        title: 'Connection URIs',
      });
      out.end();

      connectionString = data.connection_uris[0].connection_uri;
    } catch (error) {
      throw new Error(
        `An error occurred while creating a new Neon project: ${String(error)}`,
      );
    }
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
      trackEvent('create-app', { phase: 'neon-branch' });
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
      trackEvent('create-app', { phase: 'neon-role' });
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
      trackEvent('create-app', { phase: 'neon-database' });
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

  const environmentVariables: EnvironmentVariable[] = [];

  if (finalOptions.framework === 'Next.js') {
    let template;
    if (finalOptions.auth === 'auth.js' && finalOptions.orm === 'drizzle') {
      template =
        'https://github.com/neondatabase/neonctl-create-app-templates/tree/main/next-drizzle-authjs';
    } else if (
      finalOptions.auth === undefined &&
      finalOptions.orm === 'drizzle'
    ) {
      template =
        'https://github.com/neondatabase/neonctl-create-app-templates/tree/main/next-drizzle';
    } else if (
      finalOptions.auth === 'auth.js' &&
      finalOptions.orm === 'prisma'
    ) {
      template =
        'https://github.com/neondatabase/neonctl-create-app-templates/tree/add-prisma-templates/next-prisma-authjs';
    } else if (
      finalOptions.auth === undefined &&
      finalOptions.orm === 'prisma'
    ) {
      template =
        'https://github.com/neondatabase/neonctl-create-app-templates/tree/add-prisma-templates/next-prisma';
    }

    let packageManager = '--use-npm';
    if (finalOptions.packageManager === 'bun') {
      packageManager = '--use-bun';
    } else if (finalOptions.packageManager === 'pnpm') {
      packageManager = '--use-pnpm';
    }

    try {
      execSync(
        `${getCreateNextAppCommand(finalOptions.packageManager)} \
            ${packageManager} \
            --example ${template} \
            ${appName}`,
        { stdio: 'inherit' },
      );
    } catch (error: unknown) {
      throw new Error(`Creating a Next.js project failed: ${String(error)}.`);
    }

    if (finalOptions.auth === 'auth.js') {
      // Generate AUTH_SECRET using openssl
      const authSecret = execSync('openssl rand -base64 33').toString().trim();

      environmentVariables.push({
        key: 'DATABASE_URL',
        value: connectionString,
        kind: 'build',
      });
      environmentVariables.push({
        key: 'DATABASE_URL',
        value: connectionString,
        kind: 'runtime',
      });
      environmentVariables.push({
        key: 'AUTH_SECRET',
        value: authSecret,
        kind: 'build',
      });
      environmentVariables.push({
        key: 'AUTH_SECRET',
        value: authSecret,
        kind: 'runtime',
      });

      // Write the content to the .env.local file
      writeEnvFile({
        fileName: `${appName}/.env.local`,
        secrets: environmentVariables.filter((e) => e.kind === 'runtime'),
      });
    } else {
      environmentVariables.push({
        key: 'DATABASE_URL',
        value: connectionString,
        kind: 'build',
      });
      environmentVariables.push({
        key: 'DATABASE_URL',
        value: connectionString,
        kind: 'runtime',
      });

      // Write the content to the .env.local file
      writeEnvFile({
        fileName: `${appName}/.env.local`,
        secrets: environmentVariables.filter((e) => e.kind === 'runtime'),
      });
    }

    out.text(
      `Created a Next.js project in ${chalk.blue(
        appName,
      )}.\n\nYou can now run ${chalk.blue(
        `cd ${appName} && ${finalOptions.packageManager} run dev`,
      )}`,
    );
  }

  if (finalOptions.orm === 'drizzle') {
    try {
      execSync(
        `${finalOptions.packageManager} run db:generate -- --name init_db`,
        {
          cwd: appName,
          stdio: 'inherit',
        },
      );
    } catch (error) {
      throw new Error(
        `Generating the database schema failed: ${String(error)}.`,
      );
    }

    // If the user doesn't specify Auth.js, there is no schema to be applied
    // with Drizzle.
    if (finalOptions.auth === 'auth.js') {
      try {
        execSync(`${finalOptions.packageManager} run db:migrate`, {
          cwd: appName,
          stdio: 'inherit',
        });
      } catch (error) {
        throw new Error(`Applying the schema failed: ${String(error)}.`);
      }
    }

    out.text(`Database schema generated and applied.\n`);
  } else if (finalOptions.orm === 'prisma') {
    try {
      execSync(`${finalOptions.packageManager} run prisma:generate`, {
        cwd: appName,
        stdio: 'inherit',
      });
    } catch (error) {
      throw new Error(`Generating the Prisma client failed: ${String(error)}.`);
    }

    try {
      execSync(`${finalOptions.packageManager} run prisma:migrate`, {
        cwd: appName,
        stdio: 'inherit',
      });
    } catch (error) {
      throw new Error(`Applying the schema failed: ${String(error)}.`);
    }

    out.text(`Database schema generated and applied.\n`);
  }

  const { deployment } = await prompts({
    onState: onPromptState,
    type: 'select',
    name: 'deployment',
    message: `Where would you like to deploy?`,
    choices: [
      {
        title: 'Vercel',
        value: 'vercel',
        description: 'We will install the Vercel CLI globally.',
      },
      {
        title: 'Cloudflare',
        value: 'cloudflare',
        description: 'We will install the Wrangler CLI globally.',

        // Making Prisma work on Cloudflare is a bit tricky.
        disabled: finalOptions.orm === 'prisma',
      },
      { title: 'Skip this step', value: -1 },
    ],
    // Making Prisma work on Cloudflare is a bit tricky.
    warn:
      finalOptions.orm === 'prisma'
        ? 'We do not yet support Cloudflare deployments with Prisma.'
        : undefined,
    initial: 0,
  });
  finalOptions.deployment = deployment;
  trackEvent('create-app', {
    phase: 'deployment',
    meta: { deployment: finalOptions.deployment },
  });

  if (finalOptions.deployment === 'vercel') {
    try {
      const envVarsStr = environmentVariables
        .reduce<string[]>((acc, envVar) => {
          acc.push(envVar.kind === 'build' ? '--build-env' : '--env');
          acc.push(`${envVar.key}=${envVar.value}`);
          return acc;
        }, [])
        .join(' ');

      execSync(
        `${getExecutorProgram(
          finalOptions.packageManager,
        )} vercel@34.3.1 deploy ${envVarsStr}`,
        {
          cwd: appName,
          stdio: 'inherit',
        },
      );
    } catch (error) {
      throw new Error(`Deploying to Vercel failed: ${String(error)}.`);
    }
  } else if (finalOptions.deployment === 'cloudflare') {
    try {
      execSync('command -v wrangler', {
        cwd: appName,
        stdio: 'ignore',
      });
    } catch {
      try {
        execSync(
          `${finalOptions.packageManager} install -g @cloudflare/wrangler`,
          {
            cwd: appName,
            stdio: 'inherit',
          },
        );
      } catch (error) {
        throw new Error(
          `Failed to install the Cloudflare CLI: ${String(error)}.`,
        );
      }
    }

    const wranglerToml = `name = "${appName}"
compatibility_flags = [ "nodejs_compat" ]
pages_build_output_dir = ".vercel/output/static"
compatibility_date = "2022-11-30"

[vars]
${environmentVariables
  .map((envVar) => {
    if (envVar.kind === 'runtime') {
      return `${envVar.key} = "${envVar.value}"`;
    }
  })
  .join('\n')}
`;
    writeFileSync(`${appName}/wrangler.toml`, wranglerToml, 'utf8');

    try {
      execSync(
        `${getExecutorProgram(
          finalOptions.packageManager,
        )} @cloudflare/next-on-pages@1.12.1`,
        {
          cwd: appName,
          stdio: 'inherit',
        },
      );
    } catch (error) {
      throw new Error(
        `Failed to build Next.js app with next-on-pages: ${String(error)}.`,
      );
    }

    try {
      execSync(`wrangler pages deploy`, {
        cwd: appName,
        stdio: 'inherit',
      });
    } catch (error) {
      throw new Error(
        `Failed to deploy to Cloudflare Pages: ${String(error)}.`,
      );
    }
  }

  trackEvent('create-app', { phase: 'success-finish' });

  if (finalOptions.framework === 'Next.js') {
    log.info(
      chalk.green(`

You can now run:

  cd ${appName} && ${finalOptions.packageManager} run dev

to start the app locally.`),
    );
  }
};
