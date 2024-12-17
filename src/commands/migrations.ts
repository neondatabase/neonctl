import yargs from 'yargs';
import fs from 'fs/promises';
import path from 'path';
import { writer } from '../writer.js';
import { neon } from '@neondatabase/serverless';
import { CommonProps } from '../types.js';
import { createHash } from 'crypto';

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

async function readStdin(): Promise<string> {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString().trim();
}

async function createNewMigration({
  name,
  migrationsDir,
  log,
}: CreateMigrationOptions) {
  try {
    await fs.mkdir(migrationsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const upFilename = `${timestamp}-${name}.up.sql`;
    const downFilename = `${timestamp}-${name}.down.sql`;
    const upFilepath = path.join(migrationsDir, upFilename);
    const downFilepath = path.join(migrationsDir, downFilename);

    let upContent = '-- Write your migration SQL here\n';
    if (!process.stdin.isTTY) {
      upContent = await readStdin();
    }

    await fs.writeFile(upFilepath, upContent);
    await fs.writeFile(downFilepath, '-- Write your down migration SQL here\n');

    log({
      'Forward migration file': upFilepath,
      'Backward Migration File': downFilepath,
    });
  } catch (error: unknown) {
    if (error instanceof Error) {
      log({
        message: `Failed to create migration files: ${error.message}`,
      });
    } else {
      // eslint-disable-next-line no-console
      console.error(error);
      log({
        message: 'Failed to create migration files due to unexpected error.',
      });
    }
  }
}

async function applyMigrations({
  migrationsDir,
  dbUrl,
  log,
}: ApplyMigrationsOptions) {
  try {
    const sql = neon(dbUrl);

    // Check if migrations table exists
    const [tableExists] = await sql`
        SELECT EXISTS (
            SELECT 1 
            FROM pg_tables 
            WHERE schemaname = 'neon_migrations' 
            AND tablename = 'migrations'
        );`;

    // Read and sort migration files
    const files = await fs.readdir(migrationsDir);
    const migrationFiles = files.filter((f) => f.endsWith('.up.sql')).sort(); // Ensures timestamp order

    let appliedMigrations: { hash: string }[] = [];
    if (tableExists.exists) {
      appliedMigrations = (await sql`
        SELECT hash FROM neon_migrations.migrations ORDER BY created_at ASC`) as {
        hash: string;
      }[];
    }

    // Loop both tables at the same time
    const migrationsToBeApplied = [];
    for (
      let i = 0;
      i < Math.max(appliedMigrations.length, migrationFiles.length);
      i++
    ) {
      // More migrations remotely than locally
      if (i >= migrationFiles.length) {
        throw new Error('Migrations table is out of sync with migration files');
      }

      // More migrations locally than remotely
      if (i >= appliedMigrations.length) {
        migrationsToBeApplied.push(migrationFiles[i]);
        continue;
      }

      // Compare hashes
      const content = await fs.readFile(
        path.join(migrationsDir, migrationFiles[i]),
        'utf-8',
      );
      const hash = createHash('sha256').update(content).digest('hex');

      if (appliedMigrations[i].hash !== hash) {
        throw new Error('Migrations table is out of sync with migration files');
      }
    }

    if (migrationsToBeApplied.length > 0 && !tableExists.exists) {
      await sql(`
        CREATE SCHEMA IF NOT EXISTS neon_migrations

        CREATE TABLE neon_migrations.migrations (
          id bigint GENERATED ALWAYS AS IDENTITY,
          hash text NOT NULL,
          created_at bigint
        )`);
    }

    // Apply pending migrations
    const results = [];
    for (const file of migrationsToBeApplied) {
      const content = await fs.readFile(
        path.join(migrationsDir, file),
        'utf-8',
      );
      const hash = createHash('sha256').update(content).digest('hex');

      // Apply migration
      await sql.transaction([
        sql(content),
        sql`INSERT INTO neon_migrations.migrations (hash, created_at)
            VALUES (${hash}, ${new Date().getTime()})`,
      ]);

      results.push({
        file,
        status: 'applied',
        hash,
      });
    }

    log({
      message: `Ran ${results.length} migrations`,
    });
  } catch (error: unknown) {
    if (error instanceof Error) {
      log({
        message: `Failed to apply migrations: ${error.message}`,
      });
    } else {
      // eslint-disable-next-line no-console
      console.error(error);
      log({
        message: 'Failed to apply migrations due to unexpected error.',
      });
    }
  }
}
// Add this helper function
function truncateHash(hash: string): string {
  return `${hash.slice(0, 5)}...`;
}

async function listMigrations({
  migrationsDir,
  dbUrl,
  log,
}: ListMigrationsOptions) {
  try {
    const sql = neon(dbUrl);

    // Get local migrations
    const files = await fs.readdir(migrationsDir);
    const migrationFiles = files.filter((f) => f.endsWith('.up.sql')).sort();

    // Get remote migrations
    const [tableExists] = await sql`
		SELECT EXISTS (
		  SELECT 1 
		  FROM pg_tables 
		  WHERE schemaname = 'neon_migrations' 
		  AND tablename = 'migrations'
		);`;

    let remoteMigrations: { hash: string; created_at: string }[] = [];
    if (tableExists.exists) {
      remoteMigrations = (await sql`
		  SELECT hash, created_at 
		  FROM neon_migrations.migrations 
		  ORDER BY created_at ASC`) as { hash: string; created_at: string }[];
    }

    // Track all migrations (both local and remote)
    const allMigrations = new Set<string>();

    // Add local migration hashes
    const localMigrationMap = new Map<string, string>(); // hash -> filename
    for (const filename of migrationFiles) {
      const content = await fs.readFile(
        path.join(migrationsDir, filename),
        'utf-8',
      );
      const hash = createHash('sha256').update(content).digest('hex');
      localMigrationMap.set(hash, filename);
      allMigrations.add(hash);
    }

    // Add remote migration hashes
    remoteMigrations.forEach((m) => allMigrations.add(m.hash));

    // Build results combining both local and remote information
    const results = Array.from(allMigrations).map((hash) => {
      const filename = localMigrationMap.get(hash);
      const remoteMigration = remoteMigrations.find((m) => m.hash === hash);

      return {
        filename,
        hash: truncateHash(hash),
        status: remoteMigration
          ? `Applied at ${new Date(Number(remoteMigration.created_at)).toLocaleString()}`
          : 'Not applied',
      };
    });

    log(results);
  } catch (error: unknown) {
    if (error instanceof Error) {
      log({
        message: `Failed to list migrations: ${error.message}`,
      });
    } else {
      // eslint-disable-next-line no-console
      console.error(error);
      log({
        message: 'Failed to list migrations due to unexpected error.',
      });
    }
  }
}

type MigrationLogger = (
  obj: Record<string, unknown> | Record<string, unknown>[],
) => void;

function cliLogger(props: CommonProps) {
  return (input: Record<string, unknown> | Record<string, unknown>[]) => {
    if (Array.isArray(input)) {
      writer(props).end(input, { fields: Object.keys(input[0]) });
    } else {
      writer(props).end(input, { fields: Object.keys(input) });
    }
  };
}

type CreateMigrationOptions = {
  name: string;
  migrationsDir: string;
  log: MigrationLogger;
};

type ApplyMigrationsOptions = {
  migrationsDir: string;
  dbUrl: string;
  log: MigrationLogger;
};

type ListMigrationsOptions = {
  migrationsDir: string;
  dbUrl: string;
  log: MigrationLogger;
};

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
