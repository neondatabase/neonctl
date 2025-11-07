import { init } from 'neon-init';
import yargs from 'yargs';
import prompts from 'prompts';
import { sendError } from '../analytics.js';
import { updateContextFile, currentContextFile } from '../context.js';
import { log } from '../log.js';
import { isCi } from '../env.js';

export const command = 'create-app';
export const describe = 'Generate .neon context file for your Neon project';
export const builder = (yargs: yargs.Argv) =>
  yargs
    .option('context-file', {
      hidden: true,
    })
    .option('project-id', {
      describe: 'Project ID to store in .neon file',
      type: 'string',
    })
    .option('branch-id', {
      describe: 'Branch ID to store in .neon file',
      type: 'string',
    })
    .option('org-id', {
      describe: 'Organization ID to store in .neon file',
      type: 'string',
    })
    .option('with-init', {
      describe: 'Also run neon-init to initialize the project',
      type: 'boolean',
      default: false,
    })
    .strict(false);

const onPromptState = (state: {
  value: prompts.InitialReturnValue;
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

export const handler = async (args: yargs.Arguments) => {
  try {
    // Run neon-init to initialize the project (if --with-init is provided)
    if (args.withInit) {
      try {
        await init();
      } catch (initError) {
        // Log the error but continue to create .neon file
        log.warning('neon-init failed, continuing with .neon file generation');
        log.debug(
          initError instanceof Error ? initError.message : 'Unknown error',
        );
      }
    }

    // Get the context file path
    const contextFilePath =
      typeof args.contextFile === 'function'
        ? args.contextFile()
        : args.contextFile || currentContextFile();

    // Prepare context object
    const context: {
      projectId?: string;
      branchId?: string;
      orgId?: string;
    } = {};

    // Check if we're in CI or if all values are provided via flags
    const hasAllFlags =
      args.projectId && args.branchId && args.orgId ? true : false;

    if (isCi() && !hasAllFlags) {
      log.info(
        'Skipping .neon file generation in CI environment. Use --project-id, --branch-id, and --org-id flags to generate the file.',
      );
      return;
    }

    // If flags are provided, use them
    if (args.projectId) {
      context.projectId = args.projectId as string;
    }
    if (args.branchId) {
      context.branchId = args.branchId as string;
    }
    if (args.orgId) {
      context.orgId = args.orgId as string;
    }

    // If not all values are provided, prompt for them
    if (!hasAllFlags) {
      const response = await prompts(
        [
          {
            type: context.projectId ? null : 'text',
            name: 'projectId',
            message: 'Enter your Neon project ID (optional):',
            onState: onPromptState,
          },
          {
            type: context.branchId ? null : 'text',
            name: 'branchId',
            message: 'Enter your Neon branch ID (optional):',
            onState: onPromptState,
          },
          {
            type: context.orgId ? null : 'text',
            name: 'orgId',
            message: 'Enter your Neon organization ID (optional):',
            onState: onPromptState,
          },
        ],
        {
          onCancel: () => {
            log.info('Skipping .neon file generation.');
            process.exit(0);
          },
        },
      );

      // Merge prompted values with context
      if (response.projectId) {
        context.projectId = response.projectId;
      }
      if (response.branchId) {
        context.branchId = response.branchId;
      }
      if (response.orgId) {
        context.orgId = response.orgId;
      }
    }

    // Only create .neon file if at least one value is provided
    if (context.projectId || context.branchId || context.orgId) {
      updateContextFile(contextFilePath, context);
      log.info(`✓ Created .neon file at ${contextFilePath}`);
      log.info('Context saved:');
      if (context.projectId) {
        log.info(`  Project ID: ${context.projectId}`);
      }
      if (context.branchId) {
        log.info(`  Branch ID: ${context.branchId}`);
      }
      if (context.orgId) {
        log.info(`  Organization ID: ${context.orgId}`);
      }
    } else {
      log.info('No context provided. Skipping .neon file generation.');
    }
  } catch (error) {
    const exitError = new Error(`failed to run create-app`);
    sendError(exitError, 'CREATE_APP_FAILED');
    log.error(
      error instanceof Error ? error.message : 'Unknown error occurred',
    );
    process.exit(1);
  }
};
