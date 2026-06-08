/**
 * End-to-end integration test for the `\lo_*` commands against a real
 * Postgres via testcontainers.
 *
 * Round-trips a small file through `\lo_import` → `\lo_list` →
 * `\lo_export` → `\lo_unlink` and asserts byte-for-byte fidelity.
 *
 * Skipped by default (Docker required); run with:
 *   RUN_INTEGRATION=1 npx vitest run src/psql/command/cmd_lo.integration.test.ts
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Buffer } from 'node:buffer';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BackslashContext } from '../types/backslash.js';
import type { Connection } from '../types/connection.js';

import { createVarStore } from '../core/variables.js';
import { defaultSettings } from '../core/settings.js';
import { PgConnection } from '../wire/connection.js';

import { cmdLoExport, cmdLoImport, cmdLoList, cmdLoUnlink } from './cmd_lo.js';

const RUN = process.env.CI === 'true' || process.env.RUN_INTEGRATION === '1';

type StartedContainer = {
  getHost: () => string;
  getMappedPort: (p: number) => number;
  stop: () => Promise<unknown>;
};

const captureStdout = async <T>(
  fn: () => Promise<T>,
): Promise<{ out: string; value: T }> => {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: unknown) => {
    chunks.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  try {
    const value = await fn();
    return { out: chunks.join(''), value };
  } finally {
    process.stdout.write = orig;
  }
};

const mkCtx = (
  cmdName: string,
  rawArgs: string,
  conn: Connection,
): BackslashContext => {
  const settings = defaultSettings(createVarStore());
  settings.db = conn;
  let cursor = 0;
  return {
    settings,
    cmdName,
    queryBuf: '',
    rawArgs,
    nextArg: (): string | null => {
      while (cursor < rawArgs.length && /\s/.test(rawArgs[cursor])) cursor++;
      if (cursor >= rawArgs.length) return null;
      const start = cursor;
      while (cursor < rawArgs.length && !/\s/.test(rawArgs[cursor])) cursor++;
      return rawArgs.slice(start, cursor);
    },
    restOfLine: () => {
      while (cursor < rawArgs.length && /\s/.test(rawArgs[cursor])) cursor++;
      const tail = rawArgs.slice(cursor);
      cursor = rawArgs.length;
      return tail;
    },
  };
};

describe.skipIf(!RUN)('cmd_lo — integration', () => {
  let container: StartedContainer;
  let conn: Connection;
  let tmpDir: string;

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

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'psql-lo-int-'));
  }, 90_000);

  afterAll(async () => {
    if (conn) await conn.close();
    if (container) await container.stop();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('import → list → export → unlink round-trip', async () => {
    // 1. Create a payload file with non-trivial bytes (incl. high bytes).
    const inPath = path.join(tmpDir, 'input.bin');
    const payload = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) payload[i] = i;
    await fs.writeFile(inPath, payload);

    // 2. \lo_import
    const importCtx = mkCtx('lo_import', `${inPath} test-lo`, conn);
    const importCap = await captureStdout(() => cmdLoImport.run(importCtx));
    expect(importCap.value.status).toBe('ok');
    const m = /lo_import (\d+)/.exec(importCap.out);
    expect(m).not.toBeNull();
    if (m === null) throw new Error('unreachable');
    const oid = m[1];
    expect(importCtx.settings.vars.get('LASTOID')).toBe(oid);

    // 3. \lo_list shows the new OID and our comment.
    const listCtx = mkCtx('lo_list', '', conn);
    const listCap = await captureStdout(() => cmdLoList.run(listCtx));
    expect(listCap.value.status).toBe('ok');
    expect(listCap.out).toContain(oid);
    expect(listCap.out).toMatch(/test-lo/);

    // 4. \lo_export to a new file and verify byte-for-byte.
    const outPath = path.join(tmpDir, 'output.bin');
    const exportCtx = mkCtx('lo_export', `${oid} ${outPath}`, conn);
    const exportCap = await captureStdout(() => cmdLoExport.run(exportCtx));
    expect(exportCap.value.status).toBe('ok');
    expect(exportCap.out).toMatch(/lo_export/);
    const exported = await fs.readFile(outPath);
    expect(exported.equals(payload)).toBe(true);

    // 5. \lo_unlink removes the LO; subsequent list shouldn't show it.
    const unlinkCtx = mkCtx('lo_unlink', oid, conn);
    const unlinkCap = await captureStdout(() => cmdLoUnlink.run(unlinkCtx));
    expect(unlinkCap.value.status).toBe('ok');
    expect(unlinkCap.out).toMatch(new RegExp(`lo_unlink ${oid}`));

    const list2Ctx = mkCtx('lo_list', '', conn);
    const list2Cap = await captureStdout(() => cmdLoList.run(list2Ctx));
    expect(list2Cap.value.status).toBe('ok');
    expect(list2Cap.out).not.toContain(oid);
  }, 60_000);
});
