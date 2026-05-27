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
  COPY_BINARY_SIGNATURE,
  buildCopySql,
  cmdCopy,
  doCopy,
  isCopyBinaryFormat,
  isCopyTextFormat,
  parseSlashCopy,
  pumpStdinWithEofMarker,
  validateCopyBinarySignature,
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

  // -------------------------------------------------------------------------
  // Advanced syntax variants — close upstream regress gaps.
  // -------------------------------------------------------------------------

  test('subquery TO STDOUT WITH CSV HEADER (variant 1)', () => {
    // `\copy (SELECT ...) TO STDOUT WITH CSV HEADER` is the canonical
    // form for piping a query result into the user's terminal as CSV.
    const r = parseSlashCopy(
      '(SELECT 1 as a, 2 as b) TO STDOUT WITH CSV HEADER',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.direction).toBe('to');
    expect(r.value.beforeToFrom.replace(/\s+/g, ' ').trim()).toBe(
      '( SELECT 1 as a, 2 as b )',
    );
    expect(r.value.file).toBeNull();
    expect(r.value.afterToFrom).toBe('WITH CSV HEADER');
  });

  test("TO PROGRAM 'cat' (variant 2)", () => {
    // The destination form: COPY data flows from the server through psql
    // to a child shell command. Mirror of the `FROM PROGRAM` lexing path.
    const r = parseSlashCopy("psql_pipeline TO PROGRAM 'cat'");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.direction).toBe('to');
    expect(r.value.program).toBe(true);
    expect(r.value.file).toBe('cat');
    expect(r.value.beforeToFrom).toBe('psql_pipeline');
  });

  test("WITH (FORMAT csv, DELIMITER '|', HEADER true) parenthesised options (variant 3)", () => {
    // Modern WITH-options syntax (PG 9.0+). The options blob is shovelled
    // through verbatim so the server parses it.
    const r = parseSlashCopy(
      "psql_pipeline TO STDOUT WITH (FORMAT csv, DELIMITER '|', HEADER true)",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.afterToFrom).toBe(
      "WITH (FORMAT csv, DELIMITER '|', HEADER true)",
    );
    expect(r.value.file).toBeNull();
  });

  test('column list + FROM file + parenthesised WITH (variant 4)', () => {
    const r = parseSlashCopy(
      "mytable (col1, col2) FROM 'data.csv' WITH (FORMAT csv)",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.beforeToFrom.replace(/\s+/g, ' ').trim()).toBe(
      'mytable ( col1, col2 )',
    );
    expect(r.value.file).toBe('data.csv');
    expect(r.value.afterToFrom).toBe('WITH (FORMAT csv)');
    expect(r.value.direction).toBe('from');
  });

  test("TO STDOUT DELIMITER E'\\t' (variant 5: escape-string delimiter)", () => {
    // The `E'…'` escape-string form is unwrapped by the server, not by
    // us — the parser must just preserve the raw bytes in the options
    // blob so the server's WITH-DELIMITER grammar sees `E'\t'` verbatim.
    const r = parseSlashCopy("foo TO STDOUT DELIMITER E'\\t'");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.afterToFrom).toBe("DELIMITER E'\\t'");
    expect(r.value.file).toBeNull();
  });

  test('CSV DEFAULT option (variant 6, PG 17+ server feature)', () => {
    // PG 17 added the `DEFAULT '<placeholder>'` option to CSV COPY for
    // folding sentinel cells back to column defaults. Client side we
    // only need to forward the blob — the server validates and applies.
    const r = parseSlashCopy(
      "copy_default from 'd.csv' with (format 'csv', default 'placeholder')",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.file).toBe('d.csv');
    expect(r.value.afterToFrom).toBe(
      "with (format 'csv', default 'placeholder')",
    );
    expect(r.value.direction).toBe('from');
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

  // -------------------------------------------------------------------------
  // SQL emitted for each advanced syntax variant. We assert the exact text
  // the server sees so a future refactor of the option-blob lexer can't
  // silently change wire bytes.
  // -------------------------------------------------------------------------

  test('subquery TO STDOUT WITH CSV HEADER (variant 1)', () => {
    const sql = buildCopySql({
      beforeToFrom: '( SELECT 1 as a, 2 as b )',
      afterToFrom: 'WITH CSV HEADER',
      file: null,
      program: false,
      psqlInOut: false,
      direction: 'to',
    });
    expect(sql).toBe(
      'COPY ( SELECT 1 as a, 2 as b ) TO STDOUT WITH CSV HEADER',
    );
  });

  test('parenthesised options TO STDOUT (variant 3)', () => {
    const sql = buildCopySql({
      beforeToFrom: 't',
      afterToFrom: "WITH (FORMAT csv, DELIMITER '|', HEADER true)",
      file: null,
      program: false,
      psqlInOut: false,
      direction: 'to',
    });
    expect(sql).toBe(
      "COPY t TO STDOUT WITH (FORMAT csv, DELIMITER '|', HEADER true)",
    );
  });

  test('column list + parenthesised WITH FROM STDIN (variant 4)', () => {
    const sql = buildCopySql({
      beforeToFrom: 'mytable ( col1, col2 )',
      afterToFrom: 'WITH (FORMAT csv)',
      file: '/tmp/data.csv',
      program: false,
      psqlInOut: false,
      direction: 'from',
    });
    expect(sql).toBe(
      'COPY mytable ( col1, col2 ) FROM STDIN WITH (FORMAT csv)',
    );
  });

  test("DELIMITER E'\\t' (variant 5) survives unchanged", () => {
    const sql = buildCopySql({
      beforeToFrom: 'foo',
      afterToFrom: "DELIMITER E'\\t'",
      file: null,
      program: false,
      psqlInOut: false,
      direction: 'to',
    });
    expect(sql).toBe("COPY foo TO STDOUT DELIMITER E'\\t'");
  });

  test('CSV DEFAULT option preserved verbatim (variant 6)', () => {
    const sql = buildCopySql({
      beforeToFrom: 'copy_default',
      afterToFrom: "with (format 'csv', default 'placeholder')",
      file: '/tmp/d.csv',
      program: false,
      psqlInOut: false,
      direction: 'from',
    });
    expect(sql).toBe(
      "COPY copy_default FROM STDIN with (format 'csv', default 'placeholder')",
    );
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

// ---------------------------------------------------------------------------
// COPY BINARY signature + round-trip transparency.
// ---------------------------------------------------------------------------

describe('COPY_BINARY_SIGNATURE', () => {
  test('is the canonical 11-byte header (PGCOPY\\n\\xff\\r\\n\\0)', () => {
    expect(COPY_BINARY_SIGNATURE.length).toBe(11);
    expect(COPY_BINARY_SIGNATURE.toString('latin1', 0, 6)).toBe('PGCOPY');
    expect(COPY_BINARY_SIGNATURE[6]).toBe(0x0a); // \n
    expect(COPY_BINARY_SIGNATURE[7]).toBe(0xff);
    expect(COPY_BINARY_SIGNATURE[8]).toBe(0x0d); // \r
    expect(COPY_BINARY_SIGNATURE[9]).toBe(0x0a); // \n
    expect(COPY_BINARY_SIGNATURE[10]).toBe(0x00);
  });
});

describe('validateCopyBinarySignature', () => {
  test('accepts a buffer that starts with the canonical signature', () => {
    expect(validateCopyBinarySignature(COPY_BINARY_SIGNATURE)).toBeNull();
  });

  test('accepts a signature followed by flags + extension area', () => {
    // 11-byte signature + 4-byte flags (0) + 4-byte ext-len (0) = 19 bytes
    // typical minimum prefix.
    const buf = Buffer.concat([
      COPY_BINARY_SIGNATURE,
      Buffer.alloc(4), // flags
      Buffer.alloc(4), // ext-area length
    ]);
    expect(validateCopyBinarySignature(buf)).toBeNull();
  });

  test('rejects buffers that are too short', () => {
    expect(validateCopyBinarySignature(Buffer.from('PGCOPY'))).toMatch(
      /too short/,
    );
    expect(validateCopyBinarySignature(Buffer.alloc(0))).toMatch(/too short/);
  });

  test('rejects buffers with wrong signature bytes', () => {
    const broken = Buffer.from(COPY_BINARY_SIGNATURE);
    broken[0] = 0x00; // corrupt first byte
    expect(validateCopyBinarySignature(broken)).toMatch(/mismatch/);
  });

  test('rejects similar-looking but distinct prefix', () => {
    // psql text-format COPY data could start with bytes like "1\t" or so —
    // anything that doesn't match the magic should be rejected, otherwise
    // a callers' sniff would silently accept a text stream.
    const text = Buffer.from('1\talice\n2\tbob\n', 'utf8');
    expect(validateCopyBinarySignature(text)).toMatch(/mismatch/);
  });
});

describe('isCopyBinaryFormat', () => {
  test('legacy "BINARY t FROM …" syntax is detected', () => {
    expect(isCopyBinaryFormat('binary t', null)).toBe(true);
    expect(isCopyBinaryFormat('BINARY t', null)).toBe(true);
  });

  test('"WITH BINARY" tail detected', () => {
    expect(isCopyBinaryFormat('t', 'WITH BINARY')).toBe(true);
    expect(isCopyBinaryFormat('t', 'with binary')).toBe(true);
  });

  test('"WITH (FORMAT binary)" detected', () => {
    expect(isCopyBinaryFormat('t', 'WITH (FORMAT binary)')).toBe(true);
  });

  test('CSV is not binary', () => {
    expect(isCopyBinaryFormat('t', 'WITH csv')).toBe(false);
    expect(isCopyBinaryFormat('t', 'WITH (FORMAT csv)')).toBe(false);
  });

  test('text is not binary', () => {
    expect(isCopyBinaryFormat('t', null)).toBe(false);
    expect(isCopyBinaryFormat('t', 'WITH (FORMAT text)')).toBe(false);
  });

  test('a quoted "binary" literal does not false-trigger', () => {
    expect(isCopyBinaryFormat('t', "DELIMITER 'binary'")).toBe(false);
  });

  test('an E-string "binary" payload does not false-trigger', () => {
    // The stripCopyOptionsStrings helper must collapse E'…' too so that
    // a delimiter literal containing the word "binary" can't masquerade
    // as a BINARY format opt.
    expect(isCopyBinaryFormat('t', "DELIMITER E'\\tbinary'")).toBe(false);
  });

  test('"WITH (FORMAT \'binary\')" with quoted FORMAT value', () => {
    // Mirror the FORMAT-with-quotes accept in isCopyTextFormat — the
    // binary detection must agree on the same canonicalisation.
    expect(isCopyBinaryFormat('t', "WITH (FORMAT 'binary')")).toBe(true);
    expect(isCopyBinaryFormat('t', "WITH (FORMAT 'csv')")).toBe(false);
    expect(isCopyBinaryFormat('t', "WITH (FORMAT 'text')")).toBe(false);
  });
});

describe('doCopy BINARY round-trip', () => {
  // The wire path is format-agnostic: bytes captured by COPY ... TO STDOUT
  // WITH BINARY must survive a byte-for-byte trip through COPY ... FROM
  // STDIN WITH BINARY on the way back to the server. This test wires the
  // two halves end-to-end through the mock connection and asserts no
  // bytes were mangled.
  test('TO → bytes captured equal the server-emitted stream', async () => {
    // Build a minimal but valid binary header + a single trailer.
    const header = Buffer.concat([
      COPY_BINARY_SIGNATURE,
      Buffer.alloc(4), // flags = 0
      Buffer.alloc(4), // ext-len = 0
    ]);
    const trailer = Buffer.from([0xff, 0xff]); // -1 == file trailer
    const tuple = Buffer.from([
      0x00,
      0x01, // 1 field
      0x00,
      0x00,
      0x00,
      0x04, // int4: length=4
      0x00,
      0x00,
      0x00,
      0x2a, // int4 value 42
    ]);
    const stream = Buffer.concat([header, tuple, trailer]);
    const file = tmpFile('.bin');
    const { conn, recorded } = makeMockConn({
      copyOutChunks: [stream],
      copyTag: 'COPY 1',
    });
    const result = await doCopy(conn, {
      beforeToFrom: 't',
      afterToFrom: 'WITH BINARY',
      file,
      program: false,
      psqlInOut: false,
      direction: 'to',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(recorded.sql).toBe('COPY t TO STDOUT WITH BINARY');
    const captured = await fs.readFile(file);
    expect(captured.equals(stream)).toBe(true);
    // And the captured stream still validates as binary.
    expect(validateCopyBinarySignature(captured)).toBeNull();
  });

  test('FROM → bytes pushed to server equal the file contents', async () => {
    // Same shape as above, but now we go the other direction.
    const header = Buffer.concat([
      COPY_BINARY_SIGNATURE,
      Buffer.alloc(4),
      Buffer.alloc(4),
    ]);
    const trailer = Buffer.from([0xff, 0xff]);
    const tuple = Buffer.from([
      0x00, 0x01, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x2a,
    ]);
    const stream = Buffer.concat([header, tuple, trailer]);
    const file = tmpFile('.bin');
    await fs.writeFile(file, stream);
    const { conn, recorded } = makeMockConn({ copyTag: 'COPY 1' });
    const result = await doCopy(conn, {
      beforeToFrom: 't',
      afterToFrom: 'WITH BINARY',
      file,
      program: false,
      psqlInOut: false,
      direction: 'from',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(recorded.sql).toBe('COPY t FROM STDIN WITH BINARY');
    expect(recorded.copyInBytes.equals(stream)).toBe(true);
    expect(validateCopyBinarySignature(recorded.copyInBytes)).toBeNull();
  });

  test('round-trip: TO captures, then FROM replays — bytes identical', async () => {
    // End-to-end: imagine an operator running `\copy t TO 'snap.bin' WITH
    // BINARY` and later `\copy u FROM 'snap.bin' WITH BINARY`. The two
    // hops should preserve every byte.
    const stream = Buffer.concat([
      COPY_BINARY_SIGNATURE,
      Buffer.from([
        0x00,
        0x00,
        0x00,
        0x00, // flags
        0x00,
        0x00,
        0x00,
        0x00, // ext-area length
        0x00,
        0x01,
        0x00,
        0x00,
        0x00,
        0x08,
        0x12,
        0x34,
        0x56,
        0x78,
        0xab,
        0xcd,
        0xef,
        0x01, // int8 tuple
        0xff,
        0xff, // trailer
      ]),
    ]);
    const snap = tmpFile('.bin');

    // Hop 1: TO captures.
    const out = makeMockConn({
      copyOutChunks: [stream],
      copyTag: 'COPY 1',
    });
    const toResult = await doCopy(out.conn, {
      beforeToFrom: 't',
      afterToFrom: 'WITH BINARY',
      file: snap,
      program: false,
      psqlInOut: false,
      direction: 'to',
    });
    expect(toResult.ok).toBe(true);
    const captured = await fs.readFile(snap);
    expect(captured.equals(stream)).toBe(true);

    // Hop 2: FROM replays.
    const replay = makeMockConn({ copyTag: 'COPY 1' });
    const fromResult = await doCopy(replay.conn, {
      beforeToFrom: 'u',
      afterToFrom: 'WITH BINARY',
      file: snap,
      program: false,
      psqlInOut: false,
      direction: 'from',
    });
    expect(fromResult.ok).toBe(true);
    expect(replay.recorded.copyInBytes.equals(stream)).toBe(true);
  });
});

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

  test('E-string delimiter does not false-trigger (variant 5)', () => {
    // `DELIMITER E'\\t'` — the escape-string form must not look like
    // "binary" / "csv" / "format" to the keyword scan. Specifically,
    // the original strip regex didn't handle `E'…'`; this guards the
    // updated stripCopyOptionsStrings helper.
    expect(isCopyTextFormat("DELIMITER E'\\t'")).toBe(true);
    // Even pathological E-string payloads that mention "binary":
    expect(isCopyTextFormat("DELIMITER E'\\tbinary'")).toBe(true);
  });

  test('"with (format \'csv\')" — quoted FORMAT value detected', () => {
    // PG 17 introduces option values as quoted literals in the
    // parenthesised options form; the FORMAT detection must accept
    // both `format csv` and `format 'csv'`.
    expect(isCopyTextFormat("with (format 'csv')")).toBe(false);
    expect(isCopyTextFormat("with (format 'text')")).toBe(true);
    expect(isCopyTextFormat("with (format 'binary')")).toBe(false);
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

  // -------------------------------------------------------------------------
  // COPY tag suppression — TO STDOUT/PSTDOUT must NOT print "COPY N"
  // (would corrupt the data stream); TO file/PROGRAM and FROM still do.
  //
  // These tests need a stdout mock that honours the (chunk, callback) form
  // of `Writable.write` because `drainCopyTo` awaits the callback before
  // pushing the next chunk. A naive `process.stdout.write = ...` that
  // ignores the callback hangs the COPY loop.
  // -------------------------------------------------------------------------

  /** Replace `process.stdout.write` with a recorder that drives the cb. */
  const withStdoutCapture = async (
    fn: (out: { chunks: string[] }) => Promise<void>,
  ): Promise<void> => {
    const out = { chunks: [] as string[] };
    const orig = process.stdout.write.bind(process.stdout);
    const writer = (
      chunk: unknown,
      encOrCb?: unknown,
      maybeCb?: unknown,
    ): boolean => {
      const cb = typeof encOrCb === 'function' ? encOrCb : maybeCb;
      out.chunks.push(
        Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk),
      );
      if (typeof cb === 'function') (cb as (err?: Error | null) => void)(null);
      return true;
    };
    process.stdout.write = writer as typeof process.stdout.write;
    try {
      await fn(out);
    } finally {
      process.stdout.write = orig;
    }
  };

  test('TO STDOUT suppresses COPY tag (variant 1) — output stream is data, not metadata', async () => {
    // Upstream `do_copy()` quietly skips the result tag when COPY's
    // destination is psql's own stdout (`pset.queryFout`): emitting it
    // would mix the tag into the user's data stream. Mirror that here.
    const chunks = [Buffer.from('a,b\n'), Buffer.from('1,2\n')];
    const { conn, recorded } = makeMockConn({
      copyOutChunks: chunks,
      copyTag: 'COPY 1',
    });
    const ctx = makeMockCtx(
      '(SELECT 1 as a, 2 as b) TO STDOUT WITH CSV HEADER',
      settingsWithConn(conn),
    );
    await withStdoutCapture(async (out) => {
      const r = await cmdCopy.run(ctx);
      expect(r.status).toBe('ok');
      const text = out.chunks.join('');
      // The data must be present...
      expect(text).toContain('a,b');
      expect(text).toContain('1,2');
      // ...and the COPY tag must NOT be appended (would corrupt CSV).
      expect(text).not.toMatch(/COPY 1/);
      // SQL sent to the server uses the parenthesised query verbatim.
      // (Whitespace normalisation hides a tiny leading-space artifact in
      // the subquery emitter — the server is whitespace-tolerant here.)
      expect(recorded.sql.replace(/\s+/g, ' ')).toBe(
        'COPY ( SELECT 1 as a, 2 as b ) TO STDOUT WITH CSV HEADER',
      );
    });
  });

  test('TO PSTDOUT also suppresses COPY tag (PSTDOUT == STDOUT)', async () => {
    // PSTDOUT is the same code path (psql treats it identical to STDOUT
    // since we don't track current-input-source separately).
    const { conn } = makeMockConn({
      copyOutChunks: [Buffer.from('foo\n')],
      copyTag: 'COPY 1',
    });
    const ctx = makeMockCtx('t TO PSTDOUT', settingsWithConn(conn));
    await withStdoutCapture(async (out) => {
      const r = await cmdCopy.run(ctx);
      expect(r.status).toBe('ok');
      const text = out.chunks.join('');
      expect(text).toContain('foo');
      expect(text).not.toMatch(/COPY 1/);
    });
  });

  test('TO file still prints COPY tag (file destination)', async () => {
    // The tag-suppression carve-out applies ONLY to STDOUT/PSTDOUT.
    // File destinations get the standard "COPY N" footer because the
    // tag has its own stdout to land on without colliding with data.
    const file = tmpFile();
    const { conn } = makeMockConn({
      copyOutChunks: [Buffer.from('x\n')],
      copyTag: 'COPY 1',
    });
    const ctx = makeMockCtx(`t TO '${file}'`, settingsWithConn(conn));
    await withStdoutCapture(async (out) => {
      const r = await cmdCopy.run(ctx);
      expect(r.status).toBe('ok');
      expect(out.chunks.join('')).toMatch(/COPY 1/);
    });
  });

  test('TO PROGRAM still prints COPY tag (program destination, variant 2)', async () => {
    // PROGRAM is a child process — its stdout doesn't collide with ours,
    // so the COPY tag is safe to print. Use a program that actually reads
    // its stdin (`cat`) so the pipe drains on both Linux and macOS;
    // `true` exits before reading, which races EPIPE on Linux even though
    // macOS's kernel-side pipe buffering hides it.
    const { conn } = makeMockConn({
      copyOutChunks: [Buffer.from('x\n')],
      copyTag: 'COPY 1',
    });
    const ctx = makeMockCtx("t TO PROGRAM 'cat'", settingsWithConn(conn));
    await withStdoutCapture(async (out) => {
      const r = await cmdCopy.run(ctx);
      expect(r.status).toBe('ok');
      expect(out.chunks.join('')).toMatch(/COPY 1/);
    });
  });

  test('FROM STDIN still prints COPY tag (FROM never suppressed)', async () => {
    // Only TO-STDOUT triggers tag suppression. COPY FROM STDIN flows
    // data INTO the server, so the tag has nowhere to collide.
    const { conn } = makeMockConn({ copyTag: 'COPY 0' });
    const ctx = makeMockCtx('t FROM STDIN', settingsWithConn(conn));
    // Replace stdin with an empty readable so the COPY-FROM doesn't hang.
    const origStdin = process.stdin;
    Object.defineProperty(process, 'stdin', {
      value: Readable.from([]),
      configurable: true,
      writable: true,
    });
    try {
      await withStdoutCapture(async (out) => {
        const r = await cmdCopy.run(ctx);
        expect(r.status).toBe('ok');
        expect(out.chunks.join('')).toMatch(/COPY 0/);
      });
    } finally {
      Object.defineProperty(process, 'stdin', {
        value: origStdin,
        configurable: true,
        writable: true,
      });
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
