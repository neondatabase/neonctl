/*
		const migrationsTable = typeof config === 'string'
			? '__drizzle_migrations'
			: config.migrationsTable ?? '__drizzle_migrations';
		const migrationsSchema = typeof config === 'string' ? 'drizzle' : config.migrationsSchema ?? 'drizzle';
		const migrationTableCreate = sql`
			CREATE TABLE IF NOT EXISTS ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)} (
				id SERIAL PRIMARY KEY,
				hash text NOT NULL,
				created_at bigint
			)
		`;
		await session.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(migrationsSchema)}`);
		await session.execute(migrationTableCreate);

		const dbMigrations = await session.all<{ id: number; hash: string; created_at: string }>(
			sql`select id, hash, created_at from ${sql.identifier(migrationsSchema)}.${
				sql.identifier(migrationsTable)
			} order by created_at desc limit 1`,
		);
*/

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

export const builder = (
  argv: yargs.Argv<CreateMigrationProps | ApplyMigrationsProps>,
) =>
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
      (args) => createNewMigration(args),
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
      (args) => applyMigrations(args),
    );

export const handler = (args: yargs.Argv) => {
  return args;
};

type CreateMigrationProps = CommonProps & {
  name: string;
  migrationsDir: string;
};

async function readStdin(): Promise<string> {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString().trim();
}

async function createNewMigration(props: CreateMigrationProps) {
  try {
    // Ensure migrations directory exists
    await fs.mkdir(props.migrationsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const upFilename = `${timestamp}-${props.name}.up.sql`;
    const downFilename = `${timestamp}-${props.name}.down.sql`;
    const upFilepath = path.join(props.migrationsDir, upFilename);
    const downFilepath = path.join(props.migrationsDir, downFilename);

    // Check if there's piped input
    let upContent = '-- Write your migration SQL here\n';
    if (!process.stdin.isTTY) {
      upContent = await readStdin();
    }

    // Create empty migration file
    await fs.writeFile(upFilepath, upContent);
    await fs.writeFile(downFilepath, '-- Write your down migration SQL here\n');

    writer(props).end(
      {
        message: `Created two new migration files: ${upFilepath} and ${downFilepath}`,
        upFilepath,
      },
      {
        fields: ['message', 'upFilepath'],
      },
    );
  } catch (error: unknown) {
    if (error instanceof Error) {
      writer(props).end(
        {
          message: `Failed to create migration files: ${error.message}`,
        },
        { fields: ['message'] },
      );
    } else {
      // eslint-disable-next-line no-console
      console.error(error);
      writer(props).end(
        {
          message: `Failed to create migration files due to unexpected error.`,
        },
        { fields: ['message'] },
      );
    }
  }
}

type ApplyMigrationsProps = CommonProps & {
  migrationsDir: string;
  dbUrl: string;
};

async function applyMigrations(props: ApplyMigrationsProps) {
  try {
    const sql = neon(props.dbUrl);

    // Check if migrations table exists
    const [tableExists] = await sql`
        SELECT EXISTS (
            SELECT 1 
            FROM pg_tables 
            WHERE schemaname = 'neon_migrations' 
            AND tablename = 'migrations'
        );`;

    // Read and sort migration files
    const files = await fs.readdir(props.migrationsDir);
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
        path.join(props.migrationsDir, migrationFiles[i]),
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
        path.join(props.migrationsDir, file),
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

    writer(props).end(
      {
        message: `Ran ${results.length} migrations`,
      },
      { fields: ['message'] },
    );
  } catch (error: unknown) {
    if (error instanceof Error) {
      writer(props).end(
        {
          message: `Failed to apply migrations: ${error.message}`,
        },
        { fields: ['message'] },
      );
    } else {
      // eslint-disable-next-line no-console
      console.error(error);
      writer(props).end(
        {
          message: `Failed to apply migrations due to unexpected error.`,
        },
        { fields: ['message'] },
      );
    }
  }
}
