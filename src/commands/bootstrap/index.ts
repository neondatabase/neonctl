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
  Project,
  Database,
  Api,
} from '@neondatabase/api-client';
import { PROJECT_FIELDS } from '../projects.js';
import { execSync } from 'child_process';
import { trackEvent } from '../../analytics.js';
import { BRANCH_FIELDS } from '../branches.js';
import cryptoRandomString from 'crypto-random-string';
import { retryOnLock } from '../../api.js';
import { DATABASE_FIELDS } from '../databases.js';
import { getAuthjsSecret } from './authjs-secret.js';

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
  auth?: 'auth.js' | 'no-auth';
  framework: 'Next.js' | 'SvelteKit' | 'Nuxt.js';
  deployment: 'vercel' | 'cloudflare' | 'no-deployment';
  orm?: 'drizzle' | 'prisma';

  packageManager: 'npm' | 'pnpm' | 'bun';
};

export const DEFAULT_NEON_ROLE_NAME = 'neondb_owner';

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
  environment: 'development' | 'production';
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

async function createBranch({
  projectId,
  apiClient,
  name,
}: {
  appName: string;
  projectId: string;
  apiClient: Api<unknown>;
  name: string;
}) {
  const {
    data: { branch },
  } = await retryOnLock(() =>
    apiClient.createProjectBranch(projectId, {
      branch: {
        name,
      },
      endpoints: [
        {
          type: EndpointType.ReadWrite,
        },
      ],
    }),
  );

  return branch;
}

async function createDatabase({
  appName,
  projectId,
  branchId,
  apiClient,
  ownerRole,
}: {
  appName: string;
  projectId: string;
  branchId: string;
  apiClient: Api<unknown>;
  ownerRole?: string;
}): Promise<Database> {
  const {
    data: { database },
  } = await retryOnLock(() =>
    apiClient.createProjectBranchDatabase(projectId, branchId, {
      database: {
        name: `${appName}-${cryptoRandomString({
          length: 5,
          type: 'url-safe',
        })}-db`,
        owner_name: ownerRole || DEFAULT_NEON_ROLE_NAME,
      },
    }),
  );

  return database;
}

function applyMigrations({
  options,
  appName,
  connectionString,
}: {
  options: BootstrapOptions;
  appName: string;
  connectionString?: string;
}) {
  // We have to seed `env` with all of `process.env` so that things like
  // `NODE_ENV` and `PATH` are available to the child process.
  const env: Record<string, string | undefined> = {
    ...process.env,
  };
  if (connectionString) {
    env.DATABASE_URL = connectionString;
  }

  if (options.orm === 'drizzle') {
    try {
      execSync(`${options.packageManager} run db:migrate`, {
        cwd: appName,
        stdio: 'inherit',
        env,
      });
    } catch (error) {
      throw new Error(
        `Applying the schema to the dev branch failed: ${String(error)}.`,
      );
    }
  } else if (options.orm === 'prisma') {
    try {
      execSync(`${options.packageManager} run db:generate`, {
        cwd: appName,
        stdio: 'inherit',
        env,
      });
    } catch (error) {
      throw new Error(`Generating the Prisma client failed: ${String(error)}.`);
    }

    try {
      execSync(`${options.packageManager} run db:migrate -- --skip-generate`, {
        cwd: appName,
        stdio: 'inherit',
        env,
      });
    } catch (error) {
      throw new Error(`Applying the schema failed: ${String(error)}.`);
    }
  }
}

async function deployApp({
  props,
  options,
  devBranchName,
  project,
  appName,
  environmentVariables,
}: {
  props: CommonProps;
  options: BootstrapOptions;
  devBranchName: string;
  project: ProjectListItem | Project;
  environmentVariables: EnvironmentVariable[];
  appName: string;
}) {
  let {
    data: { branches },
  } = await props.apiClient.listProjectBranches(project.id);

  branches = branches.filter((branch) => branch.name !== devBranchName);

  let branchId: string;
  if (branches.length === 0) {
    throw new Error(`No branches found for the project ${project.name}.`);
  } else if (branches.length === 1) {
    branchId = branches[0].id;
  } else {
    // Excludes dev branch we created above.
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
      message: `What branch would you like to use for your deployment? (We have created a branch just for local development, which is not on this list)`,
      choices: branchChoices,
      initial: 0,
    });
    branchId = branchIdChoice;
    trackEvent('create-app', { phase: 'neon-branch-deploy' });
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
    trackEvent('create-app', { phase: 'neon-role-deploy' });
  }

  const database = await createDatabase({
    appName,
    apiClient: props.apiClient,
    branchId,
    projectId: project.id,
  });

  writer(props).end(database, {
    fields: DATABASE_FIELDS,
    title: 'Database',
  });

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
  const deployConnectionString = connectionUrl.toString();

  environmentVariables.push({
    key: 'DATABASE_URL',
    value: deployConnectionString,
    kind: 'build',
    environment: 'production',
  });
  environmentVariables.push({
    key: 'DATABASE_URL',
    value: deployConnectionString,
    kind: 'runtime',
    environment: 'production',
  });

  // If the user doesn't specify Auth.js, there is no schema to be applied
  // in Drizzle.
  if (options.auth === 'auth.js' || options.orm === 'prisma') {
    applyMigrations({
      options,
      appName,
      connectionString: deployConnectionString,
    });
  }

  if (options.deployment === 'vercel') {
    try {
      const envVarsStr = environmentVariables
        .filter((envVar) => envVar.environment === 'production')
        .reduce<string[]>((acc, envVar) => {
          acc.push(envVar.kind === 'build' ? '--build-env' : '--env');
          acc.push(`${envVar.key}=${envVar.value}`);
          return acc;
        }, [])
        .join(' ');

      execSync(
        `${getExecutorProgram(
          options.packageManager,
        )} vercel@34.3.1 deploy ${envVarsStr}`,
        {
          cwd: appName,
          stdio: 'inherit',
        },
      );
    } catch (error) {
      throw new Error(`Deploying to Vercel failed: ${String(error)}.`);
    }
  } else if (options.deployment === 'cloudflare') {
    try {
      execSync('command -v wrangler', {
        cwd: appName,
        stdio: 'ignore',
      });
    } catch {
      try {
        execSync(`${options.packageManager} install -g @cloudflare/wrangler`, {
          cwd: appName,
          stdio: 'inherit',
        });
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
  .filter((envVar) => envVar.environment === 'production')
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
          options.packageManager,
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
    max: 10,
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

  const options: BootstrapOptions = {
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
  options.packageManager = packageManagerOptions[packageManagerOption]
    .title as BootstrapOptions['packageManager'];
  trackEvent('create-app', {
    phase: 'package-manager',
    meta: { packageManager: options.packageManager },
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
  options.framework = frameworkOptions[framework]
    .title as BootstrapOptions['framework'];
  trackEvent('create-app', {
    phase: 'framework',
    meta: { framework: options.framework },
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
  options.orm = orm;
  trackEvent('create-app', { phase: 'orm', meta: { orm: options.orm } });

  const { auth } = await prompts({
    onState: onPromptState,
    type: 'select',
    name: 'auth',
    message: `What authentication framework do you want to use?`,
    choices: [
      { title: 'Auth.js', value: 'auth.js' },
      { title: 'No Authentication', value: 'no-auth' },
    ],
    initial: 0,
  });
  options.auth = auth;
  trackEvent('create-app', {
    phase: 'auth',
    meta: { auth: options.auth },
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
  let devConnectionString: string;
  const devBranchName = `dev/${cryptoRandomString({
    length: 10,
    type: 'url-safe',
  })}`;
  if (neonProject === -1) {
    try {
      // Call the API directly. This code is inspired from the `create` code in
      // `projects.ts`.
      projectCreateRequest = {
        name: `${appName}-project`,
        branch: {},
      };

      const { data: createProjectData } = await retryOnLock(() =>
        props.apiClient.createProject({
          project: projectCreateRequest,
        }),
      );

      project = createProjectData.project;

      writer(props).end(project, {
        fields: PROJECT_FIELDS,
        title: 'Project',
      });

      const branch = await createBranch({
        appName,
        apiClient: props.apiClient,
        projectId: project.id,
        name: devBranchName,
      });

      const database = await createDatabase({
        appName,
        apiClient: props.apiClient,
        branchId: branch.id,
        projectId: project.id,
      });

      writer(props).end(branch, {
        fields: BRANCH_FIELDS,
        title: 'Branch',
      });

      const {
        data: { endpoints },
      } = await props.apiClient.listProjectBranchEndpoints(
        project.id,
        branch.id,
      );
      const endpoint = endpoints.find((e) => e.type === EndpointType.ReadWrite);
      if (!endpoint) {
        throw new Error(
          `No read-write endpoint found for the project ${project.name}.`,
        );
      }

      const {
        data: { roles },
      } = await props.apiClient.listProjectBranchRoles(project.id, branch.id);
      let role;
      if (roles.length === 0) {
        throw new Error(`No roles found for the branch: ${branch.id}`);
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
        trackEvent('create-app', { phase: 'neon-role-dev' });
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
      devConnectionString = connectionUrl.toString();
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

    const branch = await createBranch({
      appName,
      apiClient: props.apiClient,
      projectId: project.id,
      name: devBranchName,
    });

    writer(props).end(branch, {
      fields: BRANCH_FIELDS,
      title: 'Branch',
    });

    const database = await createDatabase({
      appName,
      apiClient: props.apiClient,
      branchId: branch.id,
      projectId: project.id,
    });

    writer(props).end(database, {
      fields: DATABASE_FIELDS,
      title: 'Database',
    });

    const {
      data: { roles },
    } = await props.apiClient.listProjectBranchRoles(project.id, branch.id);
    let role;
    if (roles.length === 0) {
      throw new Error(`No roles found for the branch: ${branch.id}`);
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
      trackEvent('create-app', { phase: 'neon-role-dev' });
    }

    const {
      data: { endpoints },
    } = await props.apiClient.listProjectBranchEndpoints(project.id, branch.id);
    const endpoint = endpoints.find((e) => e.type === EndpointType.ReadWrite);
    if (!endpoint) {
      throw new Error(
        `No read-write endpoint found for the project ${project.name}.`,
      );
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
    devConnectionString = connectionUrl.toString();
  }

  const environmentVariables: EnvironmentVariable[] = [];

  if (options.framework === 'Next.js') {
    let template;
    if (options.auth === 'auth.js' && options.orm === 'drizzle') {
      template =
        'https://github.com/neondatabase/neonctl-create-app-templates/tree/main/next-drizzle-authjs';
    } else if (options.auth === 'no-auth' && options.orm === 'drizzle') {
      template =
        'https://github.com/neondatabase/neonctl-create-app-templates/tree/main/next-drizzle';
    } else if (options.auth === 'auth.js' && options.orm === 'prisma') {
      template =
        'https://github.com/neondatabase/neonctl-create-app-templates/tree/main/next-prisma-authjs';
    } else if (options.auth === 'no-auth' && options.orm === 'prisma') {
      template =
        'https://github.com/neondatabase/neonctl-create-app-templates/tree/main/next-prisma';
    }

    let packageManager = '--use-npm';
    if (options.packageManager === 'bun') {
      packageManager = '--use-bun';
    } else if (options.packageManager === 'pnpm') {
      packageManager = '--use-pnpm';
    }

    try {
      execSync(
        `${getCreateNextAppCommand(options.packageManager)} \
            ${packageManager} \
            --example ${template} \
            ${appName}`,
        { stdio: 'inherit' },
      );
    } catch (error: unknown) {
      throw new Error(`Creating a Next.js project failed: ${String(error)}.`);
    }

    if (options.auth === 'auth.js') {
      const devAuthSecret = getAuthjsSecret();
      const prodAuthSecret = getAuthjsSecret();

      environmentVariables.push({
        key: 'DATABASE_URL',
        value: devConnectionString,
        kind: 'build',
        environment: 'development',
      });
      environmentVariables.push({
        key: 'DATABASE_URL',
        value: devConnectionString,
        kind: 'runtime',
        environment: 'development',
      });

      environmentVariables.push({
        key: 'AUTH_SECRET',
        value: devAuthSecret,
        kind: 'build',
        environment: 'development',
      });
      environmentVariables.push({
        key: 'AUTH_SECRET',
        value: devAuthSecret,
        kind: 'runtime',
        environment: 'development',
      });

      environmentVariables.push({
        key: 'AUTH_SECRET',
        value: prodAuthSecret,
        kind: 'build',
        environment: 'production',
      });
      environmentVariables.push({
        key: 'AUTH_SECRET',
        value: prodAuthSecret,
        kind: 'runtime',
        environment: 'production',
      });

      // Write the content to the .env file
      writeEnvFile({
        fileName: `${appName}/.env`,
        secrets: environmentVariables.filter(
          (e) => e.kind === 'runtime' && e.environment === 'development',
        ),
      });
    } else {
      environmentVariables.push({
        key: 'DATABASE_URL',
        value: devConnectionString,
        kind: 'build',
        environment: 'development',
      });
      environmentVariables.push({
        key: 'DATABASE_URL',
        value: devConnectionString,
        kind: 'runtime',
        environment: 'development',
      });

      // Write the content to the .env file
      writeEnvFile({
        fileName: `${appName}/.env`,
        secrets: environmentVariables.filter(
          (e) => e.kind === 'runtime' && e.environment === 'development',
        ),
      });
    }

    out.text(
      `Created a Next.js project in ${chalk.blue(
        appName,
      )}.\n\nYou can now run ${chalk.blue(
        `cd ${appName} && ${options.packageManager} run dev`,
      )}`,
    );
  }

  if (options.orm === 'drizzle') {
    try {
      execSync(`${options.packageManager} run db:generate -- --name init_db`, {
        cwd: appName,
        stdio: 'inherit',
      });
    } catch (error) {
      throw new Error(
        `Generating the database schema failed: ${String(error)}.`,
      );
    }

    // If the user doesn't specify Auth.js, there is no schema to be applied
    // with Drizzle.
    if (options.auth === 'auth.js') {
      applyMigrations({
        options,
        appName,
      });
    }

    out.text(`Database schema generated and applied.\n`);
  } else if (options.orm === 'prisma') {
    try {
      execSync(`${options.packageManager} run db:generate`, {
        cwd: appName,
        stdio: 'inherit',
      });
    } catch (error) {
      throw new Error(`Generating the Prisma client failed: ${String(error)}.`);
    }

    try {
      execSync(
        `${options.packageManager} run db:migrate -- --name init --skip-generate`,
        {
          cwd: appName,
          stdio: 'inherit',
        },
      );
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
        disabled: options.orm === 'prisma',
      },
      { title: 'Skip this step', value: 'no-deployment' },
    ],

    // Making Prisma work on Cloudflare is a bit tricky.
    warn:
      options.orm === 'prisma'
        ? 'We do not yet support Cloudflare deployments with Prisma.'
        : undefined,

    initial: 0,
  });
  options.deployment = deployment;
  trackEvent('create-app', {
    phase: 'deployment',
    meta: { deployment: options.deployment },
  });

  if (options.deployment !== 'no-deployment') {
    await deployApp({
      options,
      props,
      devBranchName,
      project,
      appName,
      environmentVariables,
    });
  }

  trackEvent('create-app', { phase: 'success-finish' });

  if (options.framework === 'Next.js') {
    log.info(
      chalk.green(`

You can now run:

  cd ${appName} && ${options.packageManager} run dev

to start the app locally.`),
    );
  }
};
