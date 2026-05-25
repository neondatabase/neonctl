/**
 * End-to-end integration tests for the WP-21 extended-query / pipeline path
 * against a real Postgres via testcontainers.
 *
 * Skipped by default (slow + Docker required); run with:
 *   RUN_INTEGRATION=1 npx vitest run src/psql/command/cmd_pipeline.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Connection } from '../types/connection.js';

import { PgConnection } from '../wire/connection.js';

const RUN = process.env.CI === 'true' || process.env.RUN_INTEGRATION === '1';

type StartedContainer = {
  getHost: () => string;
  getMappedPort: (p: number) => number;
  stop: () => Promise<unknown>;
};

describe.skipIf(!RUN)('cmd_pipeline / extended-query — integration', () => {
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
  }, 90_000);

  afterAll(async () => {
    if (conn) await conn.close();
    if (container) await container.stop();
  });

  it('query(SELECT $1::int, $2::text) returns the bound values', async () => {
    const rs = await conn.query('SELECT $1::int, $2::text', [42, 'hello']);
    expect(rs.rows).toHaveLength(1);
    expect(rs.rows[0]).toEqual(['42', 'hello']);
    expect(rs.fields).toHaveLength(2);
  });

  it('pipeline 3 SELECTs return ordered results', async () => {
    const pipe = conn.pipeline();
    await pipe.parse('', 'SELECT 1::int', []);
    await pipe.bind('', []);
    void pipe.execute('', 0);
    await pipe.parse('', 'SELECT 2::int', []);
    await pipe.bind('', []);
    void pipe.execute('', 0);
    await pipe.parse('', 'SELECT 3::int', []);
    await pipe.bind('', []);
    void pipe.execute('', 0);
    const results = await pipe.end();
    expect(results).toHaveLength(3);
    expect(results[0].rows[0]?.[0]).toBe('1');
    expect(results[1].rows[0]?.[0]).toBe('2');
    expect(results[2].rows[0]?.[0]).toBe('3');
  });

  it('prepare + bind + execute round-trip works', async () => {
    const stmt = await conn.prepare('addone', 'SELECT $1::int + 1', [23]);
    expect(stmt.paramTypes).toEqual([23]);
    await stmt.bind(['41']);
    const rs = await stmt.execute();
    expect(rs.rows).toEqual([['42']]);
    await stmt.close();
  });
});
