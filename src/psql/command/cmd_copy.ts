/**
 * psql `\copy` backslash command (WP-16).
 *
 * Port of `parse_slash_copy()` + `do_copy()` from upstream `src/bin/psql/copy.c`.
 * The wire-level protocol (CopyData/CopyDone/CopyFail framing and the
 * in-copy-in/in-copy-out state machine) lives in `../wire/connection.ts`; here
 * we own:
 *
 *   1. Lexing the user-supplied tail of `\copy …`. Mirrors the upstream
 *      `strtokx()`-driven tokeniser: we ratchet through the input with the
 *      same whitespace/delim/quote rules so the grammar matches psql.
 *   2. Building the COPY SQL the server sees. The client side does
 *      file/program plumbing; the server always sees `... FROM STDIN ...` /
 *      `... TO STDOUT ...` so the COPY data flows over the protocol stream.
 *   3. Driving the protocol: open the file (or spawn `PROGRAM 'cmd'`), then
 *      `startCopyIn(sql)` / `startCopyOut(sql)`, push/pull bytes, and print
 *      the upstream-style `COPY <N>` summary on success.
 *
 * Grammar accepted (matching upstream documentation):
 *
 *   \copy [BINARY] tablename [(columnlist)] FROM
 *           ( 'file' | PROGRAM 'cmd' | STDIN | PSTDIN ) [options]
 *   \copy [BINARY] tablename [(columnlist)] TO
 *           ( 'file' | PROGRAM 'cmd' | STDOUT | PSTDOUT ) [options]
 *   \copy (subquery) TO   ( 'file' | PROGRAM 'cmd' | STDOUT | PSTDOUT ) [options]
 *
 * `\copy (subquery) FROM ...` is rejected — COPY FROM requires a real
 * destination table, so the subquery form only makes sense with `TO`.
 *
 * Limitations vs upstream:
 *   - Binary COPY (server-side `WITH (FORMAT BINARY)` option) is byte-for-byte
 *     transparent: bytes captured by `COPY ... TO STDOUT WITH BINARY` are
 *     piped straight to the destination, and on `COPY ... FROM STDIN WITH
 *     BINARY` we relay the source bytes verbatim. We do NOT parse tuples;
 *     `validateCopyBinarySignature` is offered for callers that want to
 *     sniff the 11-byte file header, but the wire path itself is format-
 *     agnostic. The legacy `BINARY <table> FROM …` keyword syntax is parsed
 *     and re-emitted verbatim; we don't try to interpret the options blob.
 *   - The literal `\.` end-of-data marker is honoured when (and only when):
 *     the source is STDIN, AND the COPY format is text (not csv, not binary).
 *     A line matching exactly `\.` terminates the stream client-side via
 *     CopyDone; subsequent input bytes go back to the SQL stream. Matches
 *     upstream's stricter behaviour: csv/binary COPY treats `\.` as data.
 *   - PSTDIN/PSTDOUT are treated as STDIN/STDOUT (no separate "psql stdin
 *     vs current input source" distinction — REPL plumbing isn't wired yet).
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import {
  createReadStream,
  createWriteStream,
  promises as fsPromises,
} from 'node:fs';
import { Buffer } from 'node:buffer';
import type { Readable, Writable } from 'node:stream';

import type {
  BackslashCmdSpec,
  BackslashContext,
  BackslashRegistry,
  BackslashResult,
} from '../types/backslash.js';
import type { Connection, CopyInStream } from '../types/connection.js';

import { pumpReadable } from '../wire/copy.js';

import { getPipelineState } from './cmd_pipeline.js';
import { writeErr, writeOut } from './shared.js';

/**
 * Diagnostic emitted when the user tries to run `\copy` (or a raw COPY
 * statement) inside an active `\startpipeline` ... `\endpipeline` block.
 * Matches upstream libpq's wording so conformance tests grepping stderr
 * (e.g. tap/001_basic.pl lines 490-531) pick it up unchanged. Exported so
 * the wire-layer abort path can reuse the same string and tests can match
 * via a single source of truth.
 */
export const COPY_IN_PIPELINE_MSG =
  'COPY in a pipeline is not supported, aborting connection';

// ---------------------------------------------------------------------------
// parse_slash_copy
// ---------------------------------------------------------------------------

/**
 * Result of {@link parseSlashCopy}: a normalized description of the COPY the
 * user asked for. `before_tofrom` is everything to the left of `FROM`/`TO` in
 * the form the backend expects (table + optional column list, or a
 * parenthesized subquery). `after_tofrom` is the post-filename options blob
 * we shovel through verbatim. The client-side `file` / `program` / `direction`
 * fields drive the I/O side of {@link doCopy}.
 */
export type ParsedCopy = {
  /** Text emitted between `COPY` and `FROM`/`TO` on the server side. */
  beforeToFrom: string;
  /** Verbatim post-filename options (the `WITH (...)` blob), or null. */
  afterToFrom: string | null;
  /** Filename / shell command, or null when STDIN/STDOUT. */
  file: string | null;
  /** True when `PROGRAM 'cmd'` was given; runs via `sh -c`. */
  program: boolean;
  /** PSTDIN/PSTDOUT — pipe to psql's own stdio. We ignore the distinction. */
  psqlInOut: boolean;
  /** Direction of the transfer. */
  direction: 'from' | 'to';
};

const WHITESPACE = ' \t\n\r';

/**
 * Tokenise the next term of the `\copy` tail. Mirrors upstream's `strtokx`
 * call sites: each call passes a different combination of (delim chars,
 * quote chars, allow-doubled-quotes, allow-E-strings). We faithfully replay
 * those: this isn't a general lexer, it's a state machine indexed by the
 * caller's intent.
 *
 * Returns `{ token, rest }`. `token === null` ⇒ end-of-input.
 *
 * Key differences from upstream `strtokx`:
 *   - We return tokens WITH outer quotes intact when the caller asked for
 *     them. `dequote` handles strip if desired. Upstream stores quotes
 *     in-place and optionally strips via `strip_quotes`.
 *   - Delimiter characters in `delim` are returned as single-char tokens
 *     when they're the first non-whitespace byte.
 */
const tokenize = (
  input: string,
  delim: string,
  quote: string,
  doubleQuoteEscape: boolean,
): { token: string | null; rest: string } => {
  let i = 0;
  const n = input.length;
  // 1. Skip leading whitespace.
  while (i < n && WHITESPACE.includes(input[i])) i++;
  if (i >= n) return { token: null, rest: '' };

  // 2. Delimiter character returned as single-char token.
  if (delim.length > 0 && delim.includes(input[i])) {
    const token = input[i];
    i++;
    while (i < n && WHITESPACE.includes(input[i])) i++;
    return { token, rest: input.slice(i) };
  }

  // 3. Quoted token. Upstream allows backslash-escape inside `(query)` forms
  // when standard_conforming_strings is off; we model that with the
  // `doubleQuoteEscape` flag (true ⇒ backslash escapes any next char).
  if (quote.length > 0 && quote.includes(input[i])) {
    const thisQuote = input[i];
    const start = i;
    i++;
    while (i < n) {
      const c = input[i];
      if (doubleQuoteEscape && c === '\\' && i + 1 < n) {
        i += 2;
        continue;
      }
      if (c === thisQuote && input[i + 1] === thisQuote) {
        // Doubled quote — stays in token; caller dequotes if needed.
        i += 2;
        continue;
      }
      if (c === thisQuote) {
        i++;
        break;
      }
      i++;
    }
    const token = input.slice(start, i);
    while (i < n && WHITESPACE.includes(input[i])) i++;
    return { token, rest: input.slice(i) };
  }

  // 4. Bareword: scan to next whitespace, delim, or quote.
  const start = i;
  while (i < n) {
    const c = input[i];
    if (WHITESPACE.includes(c)) break;
    if (delim.length > 0 && delim.includes(c)) break;
    if (quote.length > 0 && quote.includes(c)) break;
    i++;
  }
  const token = input.slice(start, i);
  while (i < n && WHITESPACE.includes(input[i])) i++;
  return { token, rest: input.slice(i) };
};

/**
 * Strip surrounding single quotes from a filename / program argument and
 * undouble any embedded quotes. Mirrors upstream's `strip_quotes(token, '\'', 0)`.
 */
const stripSingleQuotes = (token: string): string => {
  if (token.length < 2 || !token.startsWith("'") || !token.endsWith("'")) {
    return token;
  }
  let out = '';
  let i = 1;
  const end = token.length - 1;
  while (i < end) {
    if (token[i] === "'" && token[i + 1] === "'") {
      out += "'";
      i += 2;
    } else {
      out += token[i];
      i++;
    }
  }
  return out;
};

/**
 * Expand a leading `~/` in filename arguments. Upstream `expand_tilde` only
 * touches the very first character; we do the same (no `~user/` form, since
 * Node doesn't expose `getpwnam` cleanly).
 */
const expandTilde = (filePath: string): string => {
  if (!filePath.startsWith('~')) return filePath;
  if (filePath === '~' || filePath.startsWith('~/')) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (home === undefined) return filePath;
    return home + filePath.slice(1);
  }
  return filePath;
};

export type ParseSlashCopyResult =
  | { ok: true; value: ParsedCopy }
  | { ok: false; error: string };

/**
 * Parse the tail of a `\copy ...` line. Returns a {@link ParsedCopy} on
 * success or an error message on syntax failure (mirroring upstream's
 * `pg_log_error("\\copy: parse error at \"%s\"")`).
 *
 * The input is everything after `\copy` (the command name itself is stripped
 * by the dispatcher's `BackslashContext.rawArgs`).
 */
export const parseSlashCopy = (input: string): ParseSlashCopyResult => {
  let beforeToFrom = '';
  let rest = input;
  let token: string | null;

  // Helper to keep the failure messages consistent with upstream.
  const errAt = (tok: string | null): ParseSlashCopyResult => ({
    ok: false,
    error:
      tok !== null && tok.length > 0
        ? `parse error at "${tok}"`
        : 'parse error at end of line',
  });

  // First token: optional BINARY, or table-name / "(" for subquery.
  let r1 = tokenize(rest, '.,()', '"', false);
  token = r1.token;
  rest = r1.rest;
  if (token === null) return errAt(null);

  // Optional legacy BINARY keyword (pre-7.3 syntax). Re-emit then read next.
  if (token.toLowerCase() === 'binary') {
    beforeToFrom += token;
    r1 = tokenize(rest, '.,()', '"', false);
    token = r1.token;
    rest = r1.rest;
    if (token === null) return errAt(null);
  }

  // `(query)` subquery form? Re-emit balanced-paren contents verbatim.
  let isSubquery = false;
  if (token === '(') {
    isSubquery = true;
    let parens = 1;
    while (parens > 0) {
      beforeToFrom += ' ';
      beforeToFrom += token;
      const r = tokenize(rest, '()', '"\'', true);
      token = r.token;
      rest = r.rest;
      if (token === null) return errAt(null);
      if (token === '(') parens++;
      else if (token === ')') parens--;
    }
  }

  beforeToFrom += beforeToFrom.length > 0 ? ' ' : '';
  beforeToFrom += token;

  // Next token: schema-separator `.`, column-list opener `(`, or FROM/TO.
  let r2 = tokenize(rest, '.,()', '"', false);
  token = r2.token;
  rest = r2.rest;
  if (token === null) return errAt(null);

  // Schema-qualified `schema.table` — upstream just re-emits all three tokens.
  if (token === '.') {
    beforeToFrom += token;
    r2 = tokenize(rest, '.,()', '"', false);
    token = r2.token;
    rest = r2.rest;
    if (token === null) return errAt(null);
    beforeToFrom += token;
    r2 = tokenize(rest, '.,()', '"', false);
    token = r2.token;
    rest = r2.rest;
    if (token === null) return errAt(null);
  }

  // Parenthesised column list `(col1, col2, …)`.
  if (token === '(') {
    for (;;) {
      beforeToFrom += ' ';
      beforeToFrom += token;
      const r = tokenize(rest, '()', '"', false);
      token = r.token;
      rest = r.rest;
      if (token === null) return errAt(null);
      if (token === ')') break;
    }
    beforeToFrom += ' ';
    beforeToFrom += token;
    r2 = tokenize(rest, '.,()', '"', false);
    token = r2.token;
    rest = r2.rest;
    if (token === null) return errAt(null);
  }

  // FROM / TO keyword.
  let direction: 'from' | 'to';
  if (token.toLowerCase() === 'from') {
    direction = 'from';
  } else if (token.toLowerCase() === 'to') {
    direction = 'to';
  } else {
    return errAt(token);
  }

  // \copy (subquery) FROM is invalid — subqueries only make sense with TO.
  if (isSubquery && direction === 'from') {
    return {
      ok: false,
      error: 'cannot use COPY FROM with a (subquery) source',
    };
  }

  // Filename / PROGRAM / STDIN / STDOUT / PSTDIN / PSTDOUT.
  let r3 = tokenize(rest, ';', "'", false);
  token = r3.token;
  rest = r3.rest;
  if (token === null) return errAt(null);

  let file: string | null = null;
  let program = false;
  let psqlInOut = false;
  const lower = token.toLowerCase();

  if (lower === 'program') {
    r3 = tokenize(rest, ';', "'", false);
    token = r3.token;
    rest = r3.rest;
    if (token === null) return errAt(null);
    if (!token.startsWith("'") || !token.endsWith("'") || token.length < 2) {
      return errAt(token);
    }
    file = stripSingleQuotes(token);
    program = true;
  } else if (lower === 'stdin' || lower === 'stdout') {
    file = null;
  } else if (lower === 'pstdin' || lower === 'pstdout') {
    file = null;
    psqlInOut = true;
  } else {
    file = expandTilde(stripSingleQuotes(token));
  }

  // Collect the rest as the post-filename options blob (verbatim).
  let afterToFrom: string | null = null;
  rest = rest.trim();
  if (rest.length > 0) {
    afterToFrom = rest;
  }

  return {
    ok: true,
    value: {
      beforeToFrom,
      afterToFrom,
      file,
      program,
      psqlInOut,
      direction,
    },
  };
};

// ---------------------------------------------------------------------------
// do_copy
// ---------------------------------------------------------------------------

/**
 * Build the SQL string sent to the backend. The server always sees
 * `STDIN`/`STDOUT` here — client-side `'file'` / `PROGRAM 'cmd'` plumbing is
 * invisible to the server because that's what frontend-driven COPY is for.
 */
const buildCopySql = (opts: ParsedCopy): string => {
  const tail = opts.direction === 'from' ? ' FROM STDIN ' : ' TO STDOUT ';
  const after = opts.afterToFrom !== null ? opts.afterToFrom : '';
  return `COPY ${opts.beforeToFrom}${tail}${after}`.trimEnd();
};

/**
 * Strip single-quoted SQL string literals from a fragment so a keyword scan
 * over the result can't false-trigger on a payload character. Handles both
 * the standard `'…''…'` form (doubled-quote escape) and the escape-string
 * `E'…\…'` form (backslash-escape). Each match collapses to `''` so token
 * boundaries around the literal are preserved.
 *
 * This is lenient on the `E` prefix recognition: we don't enforce that the
 * `E` is unescaped (e.g. we'd also strip `xE'…'`). False-positive stripping
 * is safe — we only ever miss a `csv` / `binary` / `format` mention that was
 * intended as a data payload, which is exactly the case we want to skip.
 */
const stripCopyOptionsStrings = (s: string): string => {
  return s.replace(/E'(?:\\.|[^'])*'|'(?:''|[^'])*'/g, "''");
};

/**
 * Detect whether the COPY uses the (default) text format. Upstream psql only
 * honours the `\.` end-of-data marker for text-format COPY; csv/binary treat
 * the bytes as data.
 *
 * The check is a coarse keyword scan of the options string: if any of `csv`,
 * `binary`, or `format <something>` appears (case-insensitive), we assume the
 * user has explicitly selected a non-text format and disable EOF-marker
 * handling. Quoted literals (including `E'…'` escape strings) are stripped
 * first so a column-named "binary" or a `DELIMITER E'\\tbinary'` payload
 * doesn't false-trigger.
 *
 * The `FORMAT` value itself may be optionally single-quoted in the new
 * parenthesised-options syntax (e.g. `WITH (FORMAT 'csv')`); we accept either
 * a bareword or a `'…'` literal there to match upstream's option grammar.
 */
export const isCopyTextFormat = (afterToFrom: string | null): boolean => {
  if (afterToFrom === null) return true;
  // Strip quoted literals so `DELIMITER 'binary'` and `DELIMITER E'\\tcsv'`
  // don't false-trigger the format-detection regexes below.
  const stripped = stripCopyOptionsStrings(afterToFrom);
  if (/\bcsv\b/i.test(stripped)) return false;
  if (/\bbinary\b/i.test(stripped)) return false;
  // The newer WITH (FORMAT <fmt>) form — if `format` appears followed by a
  // non-text token, assume non-text. We don't try to parse the value because
  // anything other than `text` is non-default; treat any FORMAT mention as
  // "user said something explicit" and only allow the marker for `format text`.
  // Match against the ORIGINAL string for the value extraction since the
  // stripped form will have collapsed quoted values to `''`.
  const m = /\bformat\s+(?:'([A-Za-z_]+)'|([A-Za-z_]+))/i.exec(afterToFrom);
  if (m) {
    return (m[1] ?? m[2]).toLowerCase() === 'text';
  }
  return true;
};

/**
 * Mirror of `isCopyTextFormat`'s scan, but returns `true` only when the COPY
 * was explicitly opted into binary format. Used by the `\copy` driver to gate
 * the BINARY-signature byte-for-byte transparency check (we don't want to
 * touch text/csv streams).
 *
 * Matches `WITH BINARY`, `WITH (FORMAT binary)` (with or without quotes around
 * the value), the legacy psql `BINARY t FROM …` keyword (which the parser
 * folds into `beforeToFrom`), and mixed-case variants.
 */
export const isCopyBinaryFormat = (
  beforeToFrom: string,
  afterToFrom: string | null,
): boolean => {
  // Legacy syntax: the BINARY keyword sits between `\copy` and the table name,
  // which our parser preserves as the leading token of `beforeToFrom`.
  if (/^\s*binary\b/i.test(beforeToFrom)) return true;
  if (afterToFrom === null) return false;
  // Strip quoted literals (including `E'…'` escape strings) so a column-named
  // `binary` or a payload literal doesn't trigger.
  const stripped = stripCopyOptionsStrings(afterToFrom);
  // Plain `WITH BINARY` (or the bare options token).
  if (/(^|\W)binary(\W|$)/i.test(stripped)) {
    // But only when it isn't part of a `format binary` form (already covered
    // by the regex below — keep both paths so `WITH BINARY` alone still wins).
    return true;
  }
  // FORMAT value may be optionally single-quoted in WITH (FORMAT 'binary').
  const m = /\bformat\s+(?:'([A-Za-z_]+)'|([A-Za-z_]+))/i.exec(afterToFrom);
  if (m) {
    return (m[1] ?? m[2]).toLowerCase() === 'binary';
  }
  return false;
};

/**
 * PostgreSQL COPY binary-format file header signature.
 *
 * Per the docs[1]: every binary COPY stream begins with an 11-byte signature
 * (`PGCOPY\n\xff\r\n\0`), followed by a 4-byte flags field and a 4-byte
 * header-extension-area length. After that come zero-or-more tuples, then a
 * 2-byte file trailer of `0xFFFF` (Int16 `-1`).
 *
 * We expose the signature bytes (not the full 19-byte fixed prefix) so callers
 * can sniff incoming streams or assert outgoing streams without depending on
 * server-version-specific flags / extension data.
 *
 * [1] https://www.postgresql.org/docs/current/sql-copy.html#id-1.9.3.55.9.4
 */
export const COPY_BINARY_SIGNATURE: Buffer = Buffer.from([
  0x50, 0x47, 0x43, 0x4f, 0x50, 0x59, 0x0a, 0xff, 0x0d, 0x0a, 0x00,
]);

/**
 * Validate that a buffer starts with the COPY binary signature.
 *
 * Used to assert round-trip transparency: bytes captured by `COPY ... TO
 * STDOUT WITH BINARY` should be byte-for-byte acceptable to `COPY ... FROM
 * STDIN WITH BINARY` on another instance. We don't try to parse tuples —
 * that requires per-type binary decoders the printer doesn't otherwise need.
 *
 * Returns `null` on success or a short diagnostic string on failure (matching
 * the upstream wording style: "missing signature" / "wrong signature").
 */
export const validateCopyBinarySignature = (buf: Buffer): string | null => {
  if (buf.length < COPY_BINARY_SIGNATURE.length) {
    return 'missing COPY binary signature (input too short)';
  }
  for (let i = 0; i < COPY_BINARY_SIGNATURE.length; i++) {
    if (buf[i] !== COPY_BINARY_SIGNATURE[i]) {
      return 'COPY binary signature mismatch';
    }
  }
  return null;
};

/**
 * Parse a CommandComplete tag like `"COPY 17"` into its numeric row count.
 * Returns `null` when the tag is unparseable; callers print it verbatim then.
 */
const parseCopyTagRows = (tag: string | null): number | null => {
  if (tag === null) return null;
  const m = /^COPY (\d+)$/.exec(tag.trim());
  if (!m) return null;
  return parseInt(m[1], 10);
};

/**
 * Spawn `sh -c cmd` for `PROGRAM '...'`. Returns the child process plus the
 * appropriate stream end depending on COPY direction. Stderr is inherited so
 * the user sees diagnostics in their terminal.
 */
type ProgramHandles = {
  child: ChildProcessWithoutNullStreams;
  readable: Readable | null;
  writable: Writable | null;
  closed: Promise<void>;
};

const spawnProgram = (
  cmd: string,
  direction: 'from' | 'to',
): ProgramHandles => {
  const child = spawn('sh', ['-c', cmd], {
    stdio: [
      direction === 'to' ? 'pipe' : 'inherit',
      direction === 'from' ? 'pipe' : 'inherit',
      'inherit',
    ],
  }) as ChildProcessWithoutNullStreams;
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => {
      resolve();
    });
    child.once('error', () => {
      resolve();
    });
  });
  return {
    child,
    readable: direction === 'from' ? child.stdout : null,
    writable: direction === 'to' ? child.stdin : null,
    closed,
  };
};

/**
 * Drain a `CopyOutStream` (AsyncIterable<Buffer>) into a Node Writable. We
 * await each write to honour backpressure. Mirrors upstream's `handleCopyOut`
 * inner loop.
 */
const drainCopyTo = async (
  conn: Connection,
  sql: string,
  out: Writable,
): Promise<void> => {
  const copyOut = await conn.startCopyOut(sql);
  for await (const chunk of copyOut) {
    if (chunk.length === 0) continue;
    await new Promise<void>((resolve, reject) => {
      out.write(chunk, (err) => {
        if (err !== null && err !== undefined) reject(err);
        else resolve();
      });
    });
  }
};

/**
 * Pump a Readable into a CopyInStream, honouring the upstream `\.` text-mode
 * EOF marker. A line consisting EXACTLY of `\.` (LF- or CRLF-terminated) ends
 * the COPY via `copyIn.end()`; everything after the marker is left on the
 * Readable for the caller (the REPL goes back to SQL mode and reads it as
 * the next statement).
 *
 * The marker is detected by accumulating a tail buffer until we see a newline,
 * then comparing the line to `\.`. We DO NOT mutate or strip data already
 * flushed — once a chunk has been forwarded as CopyData, it's gone. The
 * implementation reads chunks, splits on newlines, and forwards complete
 * lines individually so the marker can short-circuit the stream cleanly.
 *
 * We DO NOT use `for await (const chunk of readable)` because Node destroys
 * the underlying stream when the async-iterator wrapper exits (even cleanly
 * via `break`), which would prevent the caller from resuming reads after the
 * marker. Instead we drive the readable with explicit data/end event
 * listeners, paused/resumed via `pause()`/`resume()`, and remove them once
 * the marker fires — leaving the source intact for subsequent consumption.
 *
 * Returns true if the marker was hit (caller closed the stream), false on
 * normal EOF.
 */
const pumpStdinWithEofMarker = async (
  readable: Readable,
  copyIn: CopyInStream,
): Promise<boolean> => {
  return new Promise<boolean>((resolve, reject) => {
    let tail: Buffer = Buffer.alloc(0);
    let markerHit = false;
    let settled = false;
    /** In-flight `copyIn.write` chain; we serialize writes for backpressure. */
    let writeChain: Promise<void> = Promise.resolve();

    const settle = (run: () => Promise<void>): void => {
      if (settled) return;
      settled = true;
      readable.removeListener('data', onData);
      readable.removeListener('end', onEnd);
      readable.removeListener('error', onError);
      run().then(
        () => {
          resolve(markerHit);
        },
        (err: unknown) => {
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    };

    const writeBytes = (bytes: Buffer): void => {
      if (bytes.length === 0) return;
      // Copy the slice: `subarray` views share memory with `tail`, which is
      // reassigned (and replaced by Buffer.concat) as more chunks arrive. A
      // copy keeps the queued write independent of that churn.
      const owned = Buffer.from(bytes);
      writeChain = writeChain.then(() => copyIn.write(owned));
    };

    const handleChunk = (chunk: Buffer | string): void => {
      if (settled) return;
      // Operate in the BYTE domain — never decode to a JS string. A
      // Buffer -> string -> Buffer round-trip mangles a multibyte char split
      // across chunk boundaries and any non-UTF-8 client_encoding byte
      // (LATIN1/SJIS) into U+FFFD (review item #3). stdin yields Buffers;
      // guard the rare string case without assuming a lossy re-encode.
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      tail = tail.length === 0 ? buf : Buffer.concat([tail, buf]);
      let nl = tail.indexOf(0x0a); // '\n'
      while (nl !== -1) {
        const line = tail.subarray(0, nl + 1); // includes the trailing \n
        // Match exactly `\.\n` or `\.\r\n` (0x5c 0x2e [0x0d] 0x0a). Upstream
        // rejects trailing whitespace, so the line length must be exact.
        const isMarker =
          (line.length === 3 &&
            line[0] === 0x5c &&
            line[1] === 0x2e &&
            line[2] === 0x0a) ||
          (line.length === 4 &&
            line[0] === 0x5c &&
            line[1] === 0x2e &&
            line[2] === 0x0d &&
            line[3] === 0x0a);
        if (isMarker) {
          markerHit = true;
          const leftover = Buffer.from(tail.subarray(nl + 1)); // copy out
          tail = Buffer.alloc(0);
          // Pause + remove listeners BEFORE unshifting so the post-marker
          // bytes aren't re-emitted into our own data handler.
          readable.pause();
          readable.removeListener('data', onData);
          readable.removeListener('end', onEnd);
          readable.removeListener('error', onError);
          if (leftover.length > 0) {
            readable.unshift(leftover);
          }
          settled = true;
          writeChain
            .then(() => copyIn.end())
            .then(
              () => {
                resolve(true);
              },
              (err: unknown) => {
                reject(err instanceof Error ? err : new Error(String(err)));
              },
            );
          return;
        }
        writeBytes(line);
        tail = tail.subarray(nl + 1);
        nl = tail.indexOf(0x0a);
      }
    };

    const onData = (chunk: Buffer | string): void => {
      try {
        handleChunk(chunk);
      } catch (err) {
        settle(async () => {
          try {
            await copyIn.fail(err instanceof Error ? err.message : String(err));
          } catch {
            // best-effort
          }
          throw err instanceof Error ? err : new Error(String(err));
        });
      }
    };

    const onEnd = (): void => {
      if (settled) return;
      const trailing = tail;
      tail = Buffer.alloc(0);
      settle(async () => {
        if (trailing.length > 0) {
          writeBytes(trailing);
        }
        await writeChain;
        await copyIn.end();
      });
    };

    const onError = (err: Error): void => {
      if (settled) return;
      settle(async () => {
        try {
          await copyIn.fail(err.message);
        } catch {
          // best-effort
        }
        throw err;
      });
    };

    readable.on('data', onData);
    readable.once('end', onEnd);
    readable.once('error', onError);
    // Trigger flowing mode in case the readable is paused.
    readable.resume();
  });
};

export type DoCopyResult =
  | { ok: true; tag: string | null }
  | { ok: false; error: string };

/**
 * Execute a parsed `\copy`. Opens the file (or spawns the program), wires the
 * stream into `startCopyIn` / `startCopyOut`, and returns the resulting
 * CommandComplete tag (e.g. `"COPY 17"`) on success.
 */
export const doCopy = async (
  conn: Connection,
  opts: ParsedCopy,
): Promise<DoCopyResult> => {
  const sql = buildCopySql(opts);

  // Helper to surface a uniform error shape. We deliberately keep the upstream
  // wording for the common "could not execute command" / "<file>: <reason>"
  // variants so tests / users that grep stderr keep working.
  const failWith = (msg: string): DoCopyResult => ({ ok: false, error: msg });

  // Resolve file path / program command into a Readable/Writable.
  let readable: Readable | null = null;
  let writable: Writable | null = null;
  let program: ProgramHandles | null = null;
  /**
   * True iff the data path is "psql stdin" — i.e. the user typed
   * `\copy t FROM STDIN`. Only this path honours the `\.` text-mode EOF
   * marker; file and PROGRAM sources stream verbatim to match upstream.
   */
  let fromStdin = false;
  /** Cleanup callbacks run in `finally`. */
  const cleanups: (() => Promise<void> | void)[] = [];

  if (opts.direction === 'from') {
    if (opts.file !== null) {
      if (opts.program) {
        try {
          program = spawnProgram(opts.file, 'from');
        } catch (err) {
          return failWith(
            `could not execute command "${opts.file}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        readable = program.readable;
        const p = program;
        cleanups.push(async () => {
          try {
            p.child.stdout?.destroy();
          } catch {
            // ignore
          }
          await p.closed;
        });
      } else {
        try {
          // fstat the path to reject directories before we open a stream.
          const stat = await fsPromises.stat(opts.file);
          if (stat.isDirectory()) {
            return failWith(`${opts.file}: cannot copy from/to a directory`);
          }
        } catch (err) {
          return failWith(
            `${opts.file}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const stream = createReadStream(opts.file);
        readable = stream;
        cleanups.push(
          () =>
            new Promise<void>((resolve) => {
              if (stream.destroyed) {
                resolve();
                return;
              }
              stream.once('close', () => {
                resolve();
              });
              stream.destroy();
            }),
        );
      }
    } else {
      // STDIN form — read from process.stdin. We don't differentiate
      // PSTDIN/STDIN here (see file header limitations).
      readable = process.stdin;
      fromStdin = true;
    }
  } else {
    // direction === 'to'
    if (opts.file !== null) {
      if (opts.program) {
        try {
          program = spawnProgram(opts.file, 'to');
        } catch (err) {
          return failWith(
            `could not execute command "${opts.file}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        writable = program.writable;
        const p = program;
        cleanups.push(async () => {
          try {
            p.child.stdin?.end();
          } catch {
            // ignore
          }
          await p.closed;
        });
      } else {
        try {
          // Reject if the path exists and is a directory.
          const stat = await fsPromises.stat(opts.file).catch(() => null);
          if (stat?.isDirectory()) {
            return failWith(`${opts.file}: cannot copy from/to a directory`);
          }
        } catch {
          // ENOENT is fine for write — createWriteStream will create it.
        }
        const stream = createWriteStream(opts.file);
        writable = stream;
        cleanups.push(
          () =>
            new Promise<void>((resolve, reject) => {
              stream.end((err?: Error | null) => {
                if (err) reject(err);
                else resolve();
              });
            }),
        );
      }
    } else {
      // STDOUT form. Cast through unknown because process.stdout's `Writable`
      // type isn't strictly compatible with the generic interface.
      writable = process.stdout as unknown as Writable;
    }
  }

  // Drive the COPY.
  let tag: string | null = null;
  try {
    if (opts.direction === 'from') {
      if (readable === null) {
        return failWith('no input stream for COPY FROM');
      }
      const copyIn = await conn.startCopyIn(sql);
      // STDIN honours the `\.` EOF marker for BOTH text and CSV (psql treats
      // `\.` on its own line as end-of-data in either) — only binary STDIN and
      // file/PROGRAM sources stream bytes verbatim. Gating on text-only made a
      // CSV `\copy … FROM STDIN` swallow the `\.` line as a data row and the
      // following SQL into the copy stream (review item #16).
      if (
        fromStdin &&
        !isCopyBinaryFormat(opts.beforeToFrom, opts.afterToFrom)
      ) {
        await pumpStdinWithEofMarker(readable, copyIn);
      } else {
        await pumpReadable(conn, readable, copyIn);
      }
    } else {
      if (writable === null) {
        return failWith('no output stream for COPY TO');
      }
      await drainCopyTo(conn, sql, writable);
    }
    // The connection records the trailing CommandComplete tag for us. We
    // narrow via a duck-type check so we don't tighten the Connection type.
    tag = readLastCopyTag(conn);
  } catch (err) {
    return failWith(err instanceof Error ? err.message : String(err));
  } finally {
    for (const c of cleanups) {
      try {
        await c();
      } catch {
        // best-effort cleanup
      }
    }
  }

  return { ok: true, tag };
};

/**
 * Read the connection's `lastCopyTag` if the implementation exposes it.
 * PgConnection sets this property after each COPY; mock connections in tests
 * may not, in which case we return null and the caller prints just `COPY`.
 */
const readLastCopyTag = (conn: Connection): string | null => {
  const maybe = (conn as { lastCopyTag?: unknown }).lastCopyTag;
  if (typeof maybe === 'string') return maybe;
  return null;
};

// ---------------------------------------------------------------------------
// Backslash command registration
// ---------------------------------------------------------------------------

/**
 * `\copy` command spec. Mirrors upstream's `exec_command_a_or_copy` path
 * (well, just the copy half). On success we print the trailing `COPY <N>`
 * footer to stdout, matching `do_copy`'s expectation that SendQuery's normal
 * result-printing pipeline emits the tag.
 */
export const cmdCopy: BackslashCmdSpec = {
  name: 'copy',
  helpKey: 'copy',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    if (!ctx.settings.db) {
      ctx.settings.lastErrorResult = { message: 'no connection to the server' };
      writeErr('\\copy: no connection to the server\n');
      return { status: 'error' };
    }

    // COPY is not supported inside a \startpipeline ... \endpipeline block:
    // upstream libpq aborts the connection with this exact diagnostic and
    // psql exits non-zero. Detect at the command layer so we don't even
    // send the Query — that lets us short-circuit before the protocol
    // switches into the COPY data phase (which would otherwise hang).
    //
    // We close (but do NOT null) the connection on `ctx.settings.db` so the
    // mainloop's `checkConnectionLost` polls `db.isClosed()` and surfaces
    // the standard "connection to server was lost" diagnostic + EXIT_BADCONN.
    // That matches libpq's "aborting connection" promise — the script halts
    // after this command rather than appearing to recover.
    if (getPipelineState(ctx.settings) !== null) {
      ctx.settings.lastErrorResult = { message: COPY_IN_PIPELINE_MSG };
      writeErr(`\\copy: ${COPY_IN_PIPELINE_MSG}\n`);
      try {
        await ctx.settings.db.close();
      } catch {
        // best-effort; the connection may already be dead
      }
      return { status: 'error' };
    }

    const raw = ctx.restOfLine();
    if (raw.trim().length === 0) {
      ctx.settings.lastErrorResult = { message: 'arguments required' };
      writeErr('\\copy: arguments required\n');
      return { status: 'error' };
    }

    const parsed = parseSlashCopy(raw);
    if (!parsed.ok) {
      ctx.settings.lastErrorResult = { message: parsed.error };
      writeErr(`\\copy: ${parsed.error}\n`);
      return { status: 'error' };
    }

    const result = await doCopy(ctx.settings.db, parsed.value);
    if (!result.ok) {
      ctx.settings.lastErrorResult = { message: result.error };
      writeErr(`\\copy: ${result.error}\n`);
      return { status: 'error' };
    }

    // Print the upstream-style command tag (e.g. "COPY 17") so users see the
    // same summary as `psql`. If the connection didn't surface a tag, just
    // print `COPY` — the operation still succeeded.
    //
    // BUT: when the COPY destination is psql's own stdout (i.e. `\copy ...
    // TO STDOUT` / `TO PSTDOUT`), emitting the tag would mix it into the
    // user's data stream. Upstream `do_copy()` suppresses the tag in this
    // case — `pset.queryFout` is shared between the data stream and the tag
    // print path, so the tag has nowhere to land. Mirror that here: only
    // print when the destination is a file, a program, or when the COPY is
    // a FROM (where the data flowed *into* the server, not out to stdout).
    const suppressTag =
      parsed.value.direction === 'to' &&
      parsed.value.file === null &&
      !parsed.value.program;
    if (!suppressTag) {
      const rows = parseCopyTagRows(result.tag);
      if (result.tag !== null && rows !== null) {
        writeOut(`COPY ${String(rows)}\n`);
      } else if (result.tag !== null) {
        writeOut(`${result.tag}\n`);
      } else {
        writeOut('COPY\n');
      }
    }
    return { status: 'ok' };
  },
};

/**
 * Register the `\copy` command on the supplied registry. Called from
 * `dispatch.ts::defaultRegistry()` (one new line).
 */
export const registerCopyCommands = (registry: BackslashRegistry): void => {
  registry.register(cmdCopy);
};

// Re-export for direct callers that want to bypass the dispatcher (tests).
export { buildCopySql, pumpStdinWithEofMarker };

/**
 * Convenience: encode a JS string as UTF-8 bytes for COPY FROM. Exposed so
 * tests can feed a `Buffer` to {@link doCopy} without re-implementing the
 * Readable shim.
 */
export const toBuffer = (s: string): Buffer => Buffer.from(s, 'utf8');
