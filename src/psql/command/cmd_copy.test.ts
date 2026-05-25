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
import { Readable } from 'node:stream';

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

import {
  buildCopySql,
  cmdCopy,
  doCopy,
  isCopyTextFormat,
  parseSlashCopy,
  pumpStdinWithEofMarker,
} from './cmd_copy.js';

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
  /** Whether `end()` was called on the CopyInStream. */
  ended: boolean;
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
    ended: false,
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
          recorded.ended = true;
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
// isCopyTextFormat — gate for `\.` EOF-marker handling.
// ---------------------------------------------------------------------------

describe('isCopyTextFormat', () => {
  test('null options is treated as text (the default)', () => {
    expect(isCopyTextFormat(null)).toBe(true);
  });

  test('"WITH csv" disables', () => {
    expect(isCopyTextFormat('WITH csv')).toBe(false);
  });

  test('"WITH binary" disables', () => {
    expect(isCopyTextFormat('WITH binary')).toBe(false);
  });

  test('"WITH (FORMAT csv)" disables', () => {
    expect(isCopyTextFormat('WITH (FORMAT csv)')).toBe(false);
  });

  test('"WITH (FORMAT binary)" disables', () => {
    expect(isCopyTextFormat('WITH (FORMAT binary)')).toBe(false);
  });

  test('"WITH (FORMAT text)" stays enabled', () => {
    expect(isCopyTextFormat('WITH (FORMAT text)')).toBe(true);
  });

  test('quoted "binary" in DELIMITER does not false-trigger', () => {
    // Pathological case: a delimiter literal happens to spell "binary".
    expect(isCopyTextFormat("WITH (DELIMITER 'binary')")).toBe(true);
  });

  test('case-insensitive detection', () => {
    expect(isCopyTextFormat('with CSV header')).toBe(false);
    expect(isCopyTextFormat('with Binary')).toBe(false);
  });

  test('options with HEADER only stay text', () => {
    expect(isCopyTextFormat('WITH (HEADER true)')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pumpStdinWithEofMarker — `\.` end-of-data marker honoured for STDIN+text.
// ---------------------------------------------------------------------------

/** Build a Readable that yields the given UTF-8 string. */
const stringReadable = (s: string): Readable => Readable.from([s]);

/**
 * Build a `CopyInStream` that just records the bytes written and whether
 * `end()` / `fail()` were called.
 */
type Capture = {
  bytes: Buffer;
  ended: boolean;
  failed: string | null;
};
const captureCopyIn = (): { stream: CopyInStream; capture: Capture } => {
  const capture: Capture = {
    bytes: Buffer.alloc(0),
    ended: false,
    failed: null,
  };
  const stream: CopyInStream = {
    write: (chunk) => {
      const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      capture.bytes = Buffer.concat([capture.bytes, b]);
      return Promise.resolve();
    },
    end: () => {
      capture.ended = true;
      return Promise.resolve();
    },
    fail: (reason) => {
      capture.failed = reason;
      return Promise.resolve();
    },
  };
  return { stream, capture };
};

describe('pumpStdinWithEofMarker', () => {
  test('streams entire input on normal EOF (no marker)', async () => {
    const readable = stringReadable('1,a\n2,b\n3,c\n');
    const { stream, capture } = captureCopyIn();
    const hit = await pumpStdinWithEofMarker(readable, stream);
    expect(hit).toBe(false);
    expect(capture.bytes.toString('utf8')).toBe('1,a\n2,b\n3,c\n');
    expect(capture.ended).toBe(true);
    expect(capture.failed).toBeNull();
  });

  test('terminates on `\\.` line and does not forward marker', async () => {
    const readable = stringReadable('1,a\n2,b\n\\.\n');
    const { stream, capture } = captureCopyIn();
    const hit = await pumpStdinWithEofMarker(readable, stream);
    expect(hit).toBe(true);
    expect(capture.bytes.toString('utf8')).toBe('1,a\n2,b\n');
    expect(capture.ended).toBe(true);
  });

  test('terminates on `\\.` with CRLF', async () => {
    const readable = stringReadable('foo\r\n\\.\r\nleftover\n');
    const { stream, capture } = captureCopyIn();
    const hit = await pumpStdinWithEofMarker(readable, stream);
    expect(hit).toBe(true);
    expect(capture.bytes.toString('utf8')).toBe('foo\r\n');
  });

  test('post-marker bytes are unshifted back onto the readable', async () => {
    const readable = stringReadable('row1\n\\.\nSELECT 42;\n');
    const { stream, capture } = captureCopyIn();
    await pumpStdinWithEofMarker(readable, stream);
    expect(capture.bytes.toString('utf8')).toBe('row1\n');
    // Drain the rest — it should contain the post-marker SQL.
    const leftover: Buffer[] = [];
    for await (const chunk of readable) {
      leftover.push(
        typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk,
      );
    }
    expect(Buffer.concat(leftover).toString('utf8')).toBe('SELECT 42;\n');
  });

  test('lines that LOOK like the marker but have trailing chars are data', async () => {
    // `\. foo` (with a space) is NOT the marker — should be forwarded.
    const readable = stringReadable('a\n\\. foo\nb\n');
    const { stream, capture } = captureCopyIn();
    const hit = await pumpStdinWithEofMarker(readable, stream);
    expect(hit).toBe(false);
    expect(capture.bytes.toString('utf8')).toBe('a\n\\. foo\nb\n');
  });

  test('marker split across input chunks still detected', async () => {
    // Two reads: 'foo\n\\' and '.\nbar\n' — the marker straddles the boundary.
    const readable = Readable.from(['foo\n\\', '.\nbar\n']);
    const { stream, capture } = captureCopyIn();
    const hit = await pumpStdinWithEofMarker(readable, stream);
    expect(hit).toBe(true);
    expect(capture.bytes.toString('utf8')).toBe('foo\n');
  });

  test('read error → CopyFail(reason) and rethrow', async () => {
    const readable = new Readable({
      read() {
        // Synchronously emit an error.
        this.destroy(new Error('boom'));
      },
    });
    const { stream, capture } = captureCopyIn();
    await expect(pumpStdinWithEofMarker(readable, stream)).rejects.toThrow(
      /boom/,
    );
    expect(capture.failed).toBe('boom');
    expect(capture.ended).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// doCopy with STDIN + `\.` marker → end-to-end via mock readable.
// ---------------------------------------------------------------------------

describe('doCopy STDIN with `\\.` marker', () => {
  // Helper to monkey-patch process.stdin for the duration of one test.
  const withStdin = async (
    readable: Readable,
    fn: () => Promise<void>,
  ): Promise<void> => {
    const original = process.stdin;
    Object.defineProperty(process, 'stdin', {
      value: readable,
      configurable: true,
      writable: true,
    });
    try {
      await fn();
    } finally {
      Object.defineProperty(process, 'stdin', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  };

  test('text format honours `\\.` and stops before the marker', async () => {
    const { conn, recorded } = makeMockConn({ copyTag: 'COPY 2' });
    const stdin = stringReadable('1,a\n2,b\n\\.\n');
    await withStdin(stdin, async () => {
      const result = await doCopy(conn, {
        beforeToFrom: 't',
        afterToFrom: null,
        file: null,
        program: false,
        psqlInOut: false,
        direction: 'from',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.tag).toBe('COPY 2');
      expect(recorded.copyInBytes.toString('utf8')).toBe('1,a\n2,b\n');
      expect(recorded.ended).toBe(true);
    });
  });

  test('csv format passes `\\.` through as data', async () => {
    const { conn, recorded } = makeMockConn({ copyTag: 'COPY 3' });
    const stdin = stringReadable('1,a\n\\.\n2,b\n');
    await withStdin(stdin, async () => {
      const result = await doCopy(conn, {
        beforeToFrom: 't',
        afterToFrom: 'WITH csv',
        file: null,
        program: false,
        psqlInOut: false,
        direction: 'from',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // CSV mode → all bytes forwarded verbatim, marker is NOT honoured.
      expect(recorded.copyInBytes.toString('utf8')).toBe('1,a\n\\.\n2,b\n');
    });
  });

  test('file source ignores `\\.` even with text format', async () => {
    // The marker is only honoured for STDIN; file sources always stream
    // the whole file regardless of format.
    const file = tmpFile();
    await fs.writeFile(file, '1,a\n\\.\n2,b\n', 'utf8');
    const { conn, recorded } = makeMockConn({ copyTag: 'COPY 3' });
    const result = await doCopy(conn, {
      beforeToFrom: 't',
      afterToFrom: null,
      file,
      program: false,
      psqlInOut: false,
      direction: 'from',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(recorded.copyInBytes.toString('utf8')).toBe('1,a\n\\.\n2,b\n');
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

  test('rejects with "COPY in a pipeline" diagnostic when pipeline is active', async () => {
    // \copy must short-circuit before sending Query when a pipeline session
    // is active — libpq otherwise aborts the connection with the same
    // diagnostic and tests in tests/psql-conformance/tap/001_basic.spec.ts
    // (lines 920-974) grep stderr for this exact phrase.
    const { conn } = makeMockConn({ copyTag: 'COPY 1' });
    let closed = false;
    (conn as unknown as { close: () => Promise<void> }).close =
      (): Promise<void> => {
        closed = true;
        return Promise.resolve();
      };
    let isClosedReturn = false;
    (conn as unknown as { isClosed: () => boolean }).isClosed = () =>
      isClosedReturn;
    const settings = settingsWithConn(conn);
    // Install a fake pipeline session stash so `getPipelineState` is non-null.
    const PIPELINE_KEY = Symbol.for('neonctl.psql.pipeline');
    (settings as unknown as Record<symbol, unknown>)[PIPELINE_KEY] = {
      session: {} as unknown,
      pending: [],
    };
    const ctx = makeMockCtx('psql_pipeline from stdin;', settings);
    const stderrChunks: string[] = [];
    const stderrOrig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: unknown) => {
      stderrChunks.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      const r = await cmdCopy.run(ctx);
      isClosedReturn = closed;
      expect(r.status).toBe('error');
      expect(stderrChunks.join('')).toMatch(
        /COPY in a pipeline is not supported, aborting connection/,
      );
      expect(closed).toBe(true);
      expect(settings.lastErrorResult?.message).toMatch(/COPY in a pipeline/);
    } finally {
      process.stderr.write = stderrOrig;
    }
  });
});
