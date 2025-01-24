import yargs from 'yargs';
import { CommonProps } from '../types.js';
import { log } from '../log.js';
import { writer } from '../writer.js';

// These will be implemented in the next steps
import { parseManagedServiceSql } from '../utils/sql_parser.js';
import { createProjectFromSpec } from '../utils/sql_create.js';

export const command = 'sql <sql>';
export const describe = 'Create Neon services using a SQL-like statement';
export const aliases = ['managed-service'];

export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 sql <sql>')
    .positional('sql', {
      describe: 'SQL-like specification to create a Neon managed service',
      type: 'string',
      demandOption: true,
    })
    .example(
      '$0 sql "CREATE MANAGED SERVICE mydb TYPE=POSTGRES_NEON SPECIFICATION=$$ spec:\\n  maxVCpu: 8\\n  postgresVersion: 17\\n  autoSuspend: True\\n  historyRetentionSeconds: 0\\n  setupSQL = setupSQL.sql\\n$$"',
      'Create a new Neon project with specified configuration',
    );

export const handler = async (args: CommonProps & { sql: string }) => {
  try {
    // Exclude sql property from props
    const { sql, ...props } = args;

    // 1) Parse the SQL-like statement
    const spec = parseManagedServiceSql(sql);
    const result = await createProjectFromSpec(spec, props);

    // 3) Output the result using the same writer as other commands
    const out = writer(props);
    out.write(result.project, {
      fields: ['id', 'name', 'region_id', 'created_at'],
      title: 'Project',
    });
    out.write(result.connection_uris, {
      fields: ['connection_uri'],
      title: 'Connection URIs',
    });
    out.end();
  } catch (error) {
    log.error('Failed to create managed service:', error);
    process.exit(1);
  }
};
