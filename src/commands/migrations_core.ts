import fs from 'fs/promises';
import path from 'path';
import { neon } from '@neondatabase/serverless';
import { createHash } from 'crypto';

async function readStdin(): Promise<string> {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString().trim();
}

type CreateMigrationOptions = {
  name: string;
  migrationsDir: string;
  upMigrationContent?: string;
  downMigrationContent?: string;
  log: MigrationLogger;
  processStdin: boolean;
};

export async function createNewMigration({
  name,
  migrationsDir,
  upMigrationContent = '-- Write your migration SQL here\n',
  downMigrationContent = '-- Write your down migration SQL here\n',
  log,
  processStdin,
}: CreateMigrationOptions) {
  // Validate migration name - only allow alphanumeric, dashes and underscores
  const validNamePattern = /^[a-zA-Z0-9-_]+$/;
  if (!validNamePattern.test(name)) {
    log({
      message: `Invalid migration name "${name}". Names can only contain letters, numbers, dashes and underscores.`,
    });
    return;
  }

  try {
    await fs.mkdir(migrationsDir, { recursive: true });

    // Read existing migration files
    const files = await fs.readdir(migrationsDir);
    const existingMigrationName = files.find((file) =>
      file.includes(`-${name}.`),
    );

    if (existingMigrationName) {
      log({
        message: `Migration with name "${name}" already exists: ${existingMigrationName}`,
      });
      return;
    }

    // Calculate hashes for new migration content
    const upHash = createHash('sha256')
      .update(upMigrationContent)
      .digest('hex');
    const downHash = createHash('sha256')
      .update(downMigrationContent)
      .digest('hex');

    // Check for duplicate content in existing migrations
    for (const file of files) {
      if (file.endsWith('.up.sql')) {
        const existingUpContent = await fs.readFile(
          path.join(migrationsDir, file),
          'utf-8',
        );
        const existingUpHash = createHash('sha256')
          .update(existingUpContent)
          .digest('hex');
        if (existingUpHash === upHash) {
          log({
            message: `Duplicate migration content found: The up migration content matches existing file ${file}`,
          });
          return;
        }

        const downFile = file.replace('.up.sql', '.down.sql');
        const existingDownContent = await fs.readFile(
          path.join(migrationsDir, downFile),
          'utf-8',
        );
        const existingDownHash = createHash('sha256')
          .update(existingDownContent)
          .digest('hex');
        if (existingDownHash === downHash) {
          log({
            message: `Duplicate migration content found: The down migration content matches existing file ${downFile}`,
          });
          return;
        }
      }
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const upFilename = `${timestamp}-${name}.up.sql`;
    const downFilename = `${timestamp}-${name}.down.sql`;
    const upFilepath = path.join(migrationsDir, upFilename);
    const downFilepath = path.join(migrationsDir, downFilename);

    let upContent = upMigrationContent;
    if (!process.stdin.isTTY && processStdin) {
      upContent = await readStdin();
    }

    await fs.writeFile(upFilepath, upContent);
    await fs.writeFile(downFilepath, downMigrationContent);

    log({ message: 'Created new migration files:' });
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

type ApplyMigrationsOptions = {
  migrationsDir: string;
  dbUrl: string;
  log: MigrationLogger;
};

export async function applyMigrations({
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
      await sql(`CREATE SCHEMA IF NOT EXISTS neon_migrations`);

      await sql(`
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
type ListMigrationsOptions = {
  migrationsDir: string;
  dbUrl: string;
  log: MigrationLogger;
};

export async function listMigrations({
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
      if (allMigrations.has(hash)) {
        throw new Error(`Duplicate migration hash found: ${hash}`);
      }
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
