import yargs from 'yargs';
import { writer } from '../writer.js';
import { CommonProps } from '../types.js';
import {
  applyMigrations,
  createNewMigration,
  listMigrations,
} from './migrations_core.js';

export const command = 'migrations';
export const describe = 'Manage database migrations';
export const aliases = ['migration', 'migrate'];

export const builder = (argv: yargs.Argv<CreateMigrationProps>) =>
  argv
    .usage('$0 migrations <sub-command> [options]')
    .command(
      ['new <name>', 'create <name>'],
      'Create a new migration file',
      (yargs) =>
        yargs
          .positional('name', {
            describe:
              'Migration name (alphanumeric, dashes and underscores only)',
            type: 'string',
            demandOption: true,
          })
          .options({
            'migrations-dir': {
              describe: 'Migrations directory',
              type: 'string',
              default: './neon-migrations',
            },
          })
          .check((argv) => {
            // Validate migration name
            if (!/^[a-zA-Z0-9_-]+$/.test(argv.name)) {
              throw new Error(
                'Migration name must only contain alphanumeric characters, dashes and underscores',
              );
            }
            return true;
          }),
      (args) => createNewMigrationCommand(args),
    )
    .command(
      ['up', 'apply'],
      'Apply pending migrations',
      (yargs) =>
        yargs.options({
          'migrations-dir': {
            describe: 'Migrations directory',
            type: 'string',
            default: './neon-migrations',
          },
          'db-url': {
            describe: 'Database connection URL',
            type: 'string',
            demandOption: true,
          },
        }),
      (args) => applyMigrationsCommand(args),
    )
    .command(
      'list',
      'List all migrations and their status',
      (yargs) =>
        yargs.options({
          'migrations-dir': {
            describe: 'Migrations directory',
            type: 'string',
            default: './neon-migrations',
          },
          'db-url': {
            describe: 'Database connection URL',
            type: 'string',
            demandOption: true,
          },
        }),
      (args) => listMigrationsCommand(args),
    );

export const handler = (args: yargs.Argv) => {
  return args;
};

function cliLogger(props: CommonProps) {
  return (input: Record<string, unknown> | Record<string, unknown>[]) => {
    if (Array.isArray(input)) {
      writer(props).end(input, { fields: Object.keys(input[0]) });
    } else {
      writer(props).end(input, { fields: Object.keys(input) });
    }
  };
}

type CreateMigrationProps = CommonProps & {
  name: string;
  migrationsDir: string;
};

function createNewMigrationCommand(props: CreateMigrationProps) {
  return createNewMigration({
    name: props.name,
    migrationsDir: props.migrationsDir,
    log: (obj) => {
      cliLogger(props)(obj);
    },
  });
}

type ApplyMigrationsProps = CommonProps & {
  name: string;
  dbUrl: string;
  migrationsDir: string;
};

function applyMigrationsCommand(props: ApplyMigrationsProps) {
  return applyMigrations({
    migrationsDir: props.migrationsDir,
    dbUrl: props.dbUrl,
    log: (obj) => {
      cliLogger(props)(obj);
    },
  });
}

type ListMigrationsProps = CommonProps & {
  name: string;
  dbUrl: string;
  migrationsDir: string;
};

function listMigrationsCommand(props: ListMigrationsProps) {
  return listMigrations({
    migrationsDir: props.migrationsDir,
    dbUrl: props.dbUrl,
    log: (obj) => {
      cliLogger(props)(obj);
    },
  });
}
