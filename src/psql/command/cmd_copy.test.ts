/**
 * `\copy` command tests (WP-16).
 *
 * Two halves:
 *   1. `parseSlashCopy` — pure-text grammar tests against the upstream
 *      psql shape (table FROM/TO 'file', PROGRAM 'cmd', STDIN/STDOUT,
 *      schema-qualified names, column lists, subquery form, invalid cases).
 *   2. `doCopy` — drives a mock Connection that records the COPY SQL and the
 *      bytes pushed through `startCopyIn` / pulled from `startCopyOut`.
 *      Asserts the SQL the server sees and the data the file gets.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { BackslashContext } from '../types/backslash.js';
import type { PsqlSettings } from '../types/settings.js';
import type {
  Connection,
  CopyInStream,
  CopyOutStream,
} from '../types/connection.js';

import { createVarStore } from '../core/variables.js';
import { defaultSettings } from '../core/settings.js';

import { buildCopySql, cmdCopy, doCopy, parseSlashCopy } from './cmd_copy.js';

// ---------------------------------------------------------------------------
// parseSlashCopy
// ---------------------------------------------------------------------------

describe('parseSlashCopy', () => {
  test('table FROM file', () => {
    const r = parseSlashCopy("mytable FROM 'foo.csv'");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.direction).toBe('from');
    expect(r.value.beforeToFrom).toBe('mytable');
    expect(r.value.file).toBe('foo.csv');
    expect(r.value.program).toBe(false);
    expect(r.value.afterToFrom).toBeNull();
  });

  test('table TO STDOUT WITH csv', () => {
    const r = parseSlashCopy('t TO STDOUT WITH csv');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.direction).toBe('to');
    expect(r.value.beforeToFrom).toBe('t');
    expect(r.value.file).toBeNull();
    expect(r.value.afterToFrom).toBe('WITH csv');
  });

  test('table TO file with options', () => {
    const r = parseSlashCopy("t TO 'out.csv' (FORMAT csv, HEADER true)");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.file).toBe('out.csv');
    expect(r.value.afterToFrom).toBe('(FORMAT csv, HEADER true)');
  });

  test('schema.table FROM stdin', () => {
    const r = parseSlashCopy('public.t FROM STDIN');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.beforeToFrom).toBe('public.t');
    expect(r.value.direction).toBe('from');
    expect(r.value.file).toBeNull();
  });

  test('column list', () => {
    const r = parseSlashCopy("t (id, name) FROM 'data.csv'");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.beforeToFrom.replace(/\s+/g, ' ').trim()).toBe(
      't ( id, name )',
    );
    expect(r.value.file).toBe('data.csv');
  });

  test('subquery TO', () => {
    const r = parseSlashCopy("(SELECT * FROM t) TO 'q.csv'");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.direction).toBe('to');
    expect(r.value.beforeToFrom.replace(/\s+/g, ' ').trim()).toBe(
      '( SELECT * FROM t )',
    );
    expect(r.value.file).toBe('q.csv');
  });

  test('subquery FROM is rejected', () => {
    const r = parseSlashCopy("(SELECT 1) FROM 'x.csv'");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/subquery/);
  });

  test('PROGRAM cmd', () => {
    const r = parseSlashCopy("t FROM PROGRAM 'zcat data.gz'");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.program).toBe(true);
    expect(r.value.file).toBe('zcat data.gz');
  });

  test('PROGRAM without quoted cmd → error', () => {
    const r = parseSlashCopy('t FROM PROGRAM zcat');
    expect(r.ok).toBe(false);
  });

  test('missing FROM/TO → error', () => {
    const r = parseSlashCopy("t 'foo.csv'");
    expect(r.ok).toBe(false);
  });

  test('empty input → error', () => {
    const r = parseSlashCopy('');
    expect(r.ok).toBe(false);
  });

  test('PSTDOUT', () => {
    const r = parseSlashCopy('t TO PSTDOUT');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.psqlInOut).toBe(true);
    expect(r.value.file).toBeNull();
  });

  test('BINARY keyword (legacy) is preserved', () => {
    const r = parseSlashCopy("BINARY t FROM 'd.bin'");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.beforeToFrom.toLowerCase()).toContain('binary');
  });
});

// ---------------------------------------------------------------------------
// buildCopySql
// ---------------------------------------------------------------------------

describe('buildCopySql', () => {
  test('FROM → STDIN', () => {
    const sql = buildCopySql({
      beforeToFrom: 't',
      afterToFrom: null,
      file: '/tmp/x',
      program: false,
      psqlInOut: false,
      direction: 'from',
    });
    expect(sql).toBe('COPY t FROM STDIN');
  });

  test('TO → STDOUT WITH csv', () => {
    const sql = buildCopySql({
      beforeToFrom: 't',
      afterToFrom: 'WITH csv',
      file: null,
      program: false,
      psqlInOut: false,
      direction: 'to',
    });
    expect(sql).toBe('COPY t TO STDOUT WITH csv');
  });
});

// ---------------------------------------------------------------------------
// Mock Connection driving doCopy
// ---------------------------------------------------------------------------

type Recorded = {
  sql: string;
  /** Bytes written by the COPY-IN path (FROM file → server). */
  copyInBytes: Buffer;
  /** Whether the stream was failed instead of ended cleanly. */
  failed: string | null;
};

const makeMockConn = (opts: {
  copyOutChunks?: Buffer[];
  failOnStart?: Error;
  copyTag?: string;
}): { conn: Connection; recorded: Recorded } => {
  const recorded: Recorded = {
    sql: '',
    copyInBytes: Buffer.alloc(0),
    failed: null,
  };

  const conn: Connection = {
    serverVersion: 170000,
    parameterStatus: () => undefined,
    query: () => Promise.reject(new Error('unused')),
    execSimple: () => Promise.reject(new Error('unused')),
    prepare: () => Promise.reject(new Error('unused')),
    startCopyIn: (sql: string): Promise<CopyInStream> => {
      recorded.sql = sql;
      if (opts.failOnStart) return Promise.reject(opts.failOnStart);
      const stream: CopyInStream = {
        write: (chunk) => {
          const b =
            typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
          recorded.copyInBytes = Buffer.concat([recorded.copyInBytes, b]);
          return Promise.resolve();
        },
        end: () => {
          // The PgConnection sets lastCopyTag during the message dispatch; in
          // the mock we just stamp it after end() so doCopy reads it back.
          (conn as { lastCopyTag?: string | null }).lastCopyTag =
            opts.copyTag ?? `COPY 0`;
          return Promise.resolve();
        },
        fail: (reason: string) => {
          recorded.failed = reason;
          return Promise.resolve();
        },
      };
      return Promise.resolve(stream);
    },
    startCopyOut: (sql: string): Promise<CopyOutStream> => {
      recorded.sql = sql;
      if (opts.failOnStart) return Promise.reject(opts.failOnStart);
      const chunks = opts.copyOutChunks ?? [];
      const stream: CopyOutStream = {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            next: (): Promise<IteratorResult<Buffer>> => {
              if (i < chunks.length) {
                return Promise.resolve({ value: chunks[i++], done: false });
              }
              (conn as { lastCopyTag?: string | null }).lastCopyTag =
                opts.copyTag ?? `COPY ${String(chunks.length)}`;
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
      };
      return Promise.resolve(stream);
    },
    pipeline: () => {
      throw new Error('unused');
    },
    cancel: () => Promise.resolve(),
    escapeIdentifier: (v: string) => `"${v}"`,
    escapeLiteral: (v: string) => `'${v}'`,
    onNotice: () => () => undefined,
    onNotification: () => () => undefined,
    close: () => Promise.resolve(),
    isClosed: () => false,
  };
  return { conn, recorded };
};

// ---------------------------------------------------------------------------
// Temp-dir helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'psql-copy-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const tmpFile = (suffix = '.csv'): string =>
  path.join(tmpDir, `f-${randomUUID()}${suffix}`);

// ---------------------------------------------------------------------------
// doCopy
// ---------------------------------------------------------------------------

describe('doCopy', () => {
  test('FROM file streams bytes through startCopyIn and reports tag', async () => {
    const file = tmpFile();
    const payload = '1,alice\n2,bob\n';
    await fs.writeFile(file, payload, 'utf8');

    const { conn, recorded } = makeMockConn({ copyTag: 'COPY 2' });
    const result = await doCopy(conn, {
      beforeToFrom: 't',
      afterToFrom: 'WITH csv',
      file,
      program: false,
      psqlInOut: false,
      direction: 'from',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tag).toBe('COPY 2');
    expect(recorded.sql).toBe('COPY t FROM STDIN WITH csv');
    expect(recorded.copyInBytes.toString('utf8')).toBe(payload);
  });

  test('TO file collects bytes from startCopyOut and writes them', async () => {
    const file = tmpFile();
    const chunks = [Buffer.from('hello\n'), Buffer.from('world\n')];
    const { conn, recorded } = makeMockConn({
      copyOutChunks: chunks,
      copyTag: 'COPY 2',
    });
    const result = await doCopy(conn, {
      beforeToFrom: 't',
      afterToFrom: null,
      file,
      program: false,
      psqlInOut: false,
      direction: 'to',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tag).toBe('COPY 2');
    expect(recorded.sql).toBe('COPY t TO STDOUT');
    const contents = await fs.readFile(file, 'utf8');
    expect(contents).toBe('hello\nworld\n');
  });

  test('FROM nonexistent file → error', async () => {
    const { conn } = makeMockConn({});
    const result = await doCopy(conn, {
      beforeToFrom: 't',
      afterToFrom: null,
      file: path.join(tmpDir, 'does-not-exist'),
      program: false,
      psqlInOut: false,
      direction: 'from',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/does-not-exist/);
  });

  test('FROM directory → error', async () => {
    const { conn } = makeMockConn({});
    const result = await doCopy(conn, {
      beforeToFrom: 't',
      afterToFrom: null,
      file: tmpDir,
      program: false,
      psqlInOut: false,
      direction: 'from',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/directory/);
  });

  test('server ErrorResponse during start surfaces', async () => {
    const file = tmpFile();
    await fs.writeFile(file, 'data\n', 'utf8');
    const err = new Error('relation "missing" does not exist');
    const { conn } = makeMockConn({ failOnStart: err });
    const result = await doCopy(conn, {
      beforeToFrom: 'missing',
      afterToFrom: null,
      file,
      program: false,
      psqlInOut: false,
      direction: 'from',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/relation "missing"/);
  });
});

// ---------------------------------------------------------------------------
// cmdCopy.run — backslash dispatch entry
// ---------------------------------------------------------------------------

const makeMockCtx = (
  rawArgs: string,
  settings: PsqlSettings,
): BackslashContext => {
  let consumed = false;
  return {
    settings,
    cmdName: 'copy',
    queryBuf: '',
    rawArgs,
    nextArg: () => null,
    restOfLine: () => {
      if (consumed) return '';
      consumed = true;
      return rawArgs;
    },
  };
};

const settingsWithConn = (conn: Connection | null): PsqlSettings => {
  const s = defaultSettings(createVarStore());
  s.db = conn;
  return s;
};

describe('cmdCopy.run', () => {
  test('no connection → error', async () => {
    const ctx = makeMockCtx("t FROM 'x.csv'", settingsWithConn(null));
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdoutOrig = process.stdout.write.bind(process.stdout);
    const stderrOrig = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: unknown) => {
      stdoutChunks.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown) => {
      stderrChunks.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      const r = await cmdCopy.run(ctx);
      expect(r.status).toBe('error');
      expect(stderrChunks.join('')).toMatch(/no connection/);
    } finally {
      process.stdout.write = stdoutOrig;
      process.stderr.write = stderrOrig;
    }
  });

  test('parse error → error result + stderr', async () => {
    const { conn } = makeMockConn({});
    const ctx = makeMockCtx('this is garbage', settingsWithConn(conn));
    const stderrChunks: string[] = [];
    const stderrOrig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: unknown) => {
      stderrChunks.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      const r = await cmdCopy.run(ctx);
      expect(r.status).toBe('error');
      expect(stderrChunks.join('')).toMatch(/\\copy:/);
    } finally {
      process.stderr.write = stderrOrig;
    }
  });

  test('full happy path prints COPY <N>', async () => {
    const file = tmpFile();
    await fs.writeFile(file, 'a,b\n', 'utf8');
    const { conn, recorded } = makeMockConn({ copyTag: 'COPY 1' });
    const ctx = makeMockCtx(`t FROM '${file}'`, settingsWithConn(conn));
    const stdoutChunks: string[] = [];
    const stdoutOrig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: unknown) => {
      stdoutChunks.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    try {
      const r = await cmdCopy.run(ctx);
      expect(r.status).toBe('ok');
      expect(stdoutChunks.join('')).toMatch(/COPY 1/);
      expect(recorded.copyInBytes.toString('utf8')).toBe('a,b\n');
    } finally {
      process.stdout.write = stdoutOrig;
    }
  });
});
