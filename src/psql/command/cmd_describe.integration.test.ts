/**
 * End-to-end integration test for `\d <table>` against a real Postgres
 * via testcontainers.
 *
 * Skipped by default (slow + Docker required); run with:
 *   RUN_INTEGRATION=1 npx vitest run src/psql/command/cmd_describe.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Connection } from '../types/connection.js';

import { createVarStore } from '../core/variables.js';
import { defaultSettings } from '../core/settings.js';
import { PgConnection } from '../wire/connection.js';

import { createBackslashRegistry } from './dispatch.js';
import { registerDescribeCommands } from './cmd_describe.js';

const RUN = process.env.CI === 'true' || process.env.RUN_INTEGRATION === '1';

// We import lazily so the module isn't required when the test is skipped.
type StartedContainer = {
  getHost: () => string;
  getMappedPort: (p: number) => number;
  stop: () => Promise<unknown>;
};

describe.skipIf(!RUN)('cmd_describe — integration', () => {
  let container: StartedContainer;
  let conn: Connection;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('testdb')
      .withUsername('test')
      .withPassword('test')
      .start();

    conn = await PgConnection.connect({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: 'test',
      password: 'test',
      database: 'testdb',
      ssl: 'disable',
    });

    await conn.query(
      'CREATE TABLE widgets (' +
        '  id serial PRIMARY KEY,' +
        '  name text NOT NULL,' +
        '  price numeric(10,2) CHECK (price >= 0)' +
        ')',
      [],
    );
    await conn.query('CREATE INDEX widgets_name_idx ON widgets (name)', []);
  }, 90_000);

  afterAll(async () => {
    if (conn) await conn.close();
    if (container) await container.stop();
  });

  it('\\d widgets renders columns, indexes, and constraints', async () => {
    const r = createBackslashRegistry();
    registerDescribeCommands(r);

    const settings = defaultSettings(createVarStore());
    settings.db = conn;

    // Capture stdout for this test.
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: unknown) => {
      chunks.push(String(c));
      return true;
    }) as typeof process.stdout.write;

    try {
      const spec = r.lookup('d');
      if (!spec) throw new Error('no \\d spec registered');
      let cursor = 0;
      const rawArgs = 'widgets';
      const res = await spec.run({
        settings,
        cmdName: 'd',
        queryBuf: '',
        rawArgs,
        nextArg: () => {
          while (cursor < rawArgs.length && /\s/.test(rawArgs[cursor]))
            cursor++;
          if (cursor >= rawArgs.length) return null;
          const start = cursor;
          while (cursor < rawArgs.length && !/\s/.test(rawArgs[cursor]))
            cursor++;
          return rawArgs.slice(start, cursor);
        },
        restOfLine: () => rawArgs.slice(cursor),
      });
      expect(res.status).toBe('ok');
    } finally {
      process.stdout.write = origWrite;
    }

    const text = chunks.join('');
    expect(text).toContain('Table "public.widgets"');
    expect(text).toContain('id');
    expect(text).toContain('name');
    expect(text).toContain('price');
    expect(text).toContain('Indexes:');
    expect(text).toContain('widgets_pkey');
    expect(text).toContain('widgets_name_idx');
    expect(text).toContain('Check constraints:');
  });

  it('\\dt lists the widgets table', async () => {
    const r = createBackslashRegistry();
    registerDescribeCommands(r);
    const settings = defaultSettings(createVarStore());
    settings.db = conn;

    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: unknown) => {
      chunks.push(String(c));
      return true;
    }) as typeof process.stdout.write;

    try {
      const spec = r.lookup('dt');
      if (!spec) throw new Error('no \\dt spec registered');
      const res = await spec.run({
        settings,
        cmdName: 'dt',
        queryBuf: '',
        rawArgs: '',
        nextArg: () => null,
        restOfLine: () => '',
      });
      expect(res.status).toBe('ok');
    } finally {
      process.stdout.write = origWrite;
    }

    const text = chunks.join('');
    expect(text).toContain('widgets');
  });
});
