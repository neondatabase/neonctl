/**
 * psql large-object backslash commands (WP-23).
 *
 * TypeScript port of upstream `src/bin/psql/large_obj.c`:
 *
 *   - `\lo_list` / `\lo_list+` — list large-object metadata
 *   - `\lo_import FILE [COMMENT]` — read a local file, store as new LO
 *   - `\lo_export OID FILE` — read LO, write to a local file
 *   - `\lo_unlink OID` — delete an LO
 *
 * The upstream `do_lo_*` functions wrap their work in
 * `start_lo_xact`/`finish_lo_xact` and call libpq's lo client API
 * (`lo_import`, `lo_export`, `lo_unlink`). We don't have libpq's
 * client-side large-object API in this TS port, so we drive the same
 * operations through the server-side functions that psql ≥ 9.4 exposes:
 *
 *   - `pg_catalog.lo_from_bytea(0, $bytea)` returns the new OID in one
 *     call (replaces the upstream lo_creat + lo_write loop).
 *   - `pg_catalog.lo_get($oid)` returns the bytes as a `bytea` value.
 *   - `pg_catalog.lo_unlink($oid)` deletes the LO.
 *
 * All three calls use the connection's extended-query path (WP-21) for
 * parameter binding, which keeps us out of the libpq escape dance.
 * Bytea payloads are sent as `\x<hex>` text — the server's text-format
 * bytea parser converts back to bytes.
 *
 * `\lo_list` runs the same SELECT against `pg_largeobject_metadata` that
 * upstream's `listLargeObjects()` from `describe.c` uses (already ported
 * in WP-20's `queries.ts::listLargeObjects`). We register a primary
 * `lo_list` / `lo_list+` spec here so the dispatcher takes our entry
 * over the existing alias `dl::lo_list` (which would not match the
 * `+` suffix).
 *
 * Variable side-effects: `\lo_import` sets `LASTOID` to the new OID
 * (mirrors `do_lo_import`'s `SetVariable(pset.vars, "LASTOID", oidbuf)`).
 */

import { promises as fsPromises } from 'node:fs';
import { Buffer } from 'node:buffer';

import type {
  BackslashCmdSpec,
  BackslashContext,
  BackslashRegistry,
  BackslashResult,
} from '../types/backslash.js';
import type { Connection } from '../types/connection.js';

import { alignedPrinter } from '../print/aligned.js';
import { listLargeObjects } from '../describe/queries.js';

import { writeErr, writeOut } from './shared.js';

// ---------------------------------------------------------------------------
// Helpers shared by all four commands
// ---------------------------------------------------------------------------

/** Return the live connection, or null. */
const conn = (ctx: BackslashContext): Connection | null => ctx.settings.db;

/** Emit "no current connection" error in the psql style. */
const noConn = (ctx: BackslashContext): BackslashResult => {
  writeErr(`\\${ctx.cmdName}: no connection to the server\n`);
  ctx.settings.lastErrorResult = { message: 'no connection to the server' };
  return { status: 'error' };
};

/** Pull the diagnostic-style error message off a thrown value. */
const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Encode a `Buffer` as a Postgres text-format bytea literal: `\x<hex>`.
 * Hex form is unambiguous and works regardless of `bytea_output` or
 * `standard_conforming_strings`.
 */
const byteaText = (buf: Buffer): string => `\\x${buf.toString('hex')}`;

/**
 * Parse a string argument as an unsigned 32-bit OID. Returns `null` on
 * malformed input (negative, non-integer, or out of range). Matches the
 * permissive behaviour of upstream `atooid`, which accepts any leading
 * digit run.
 */
const parseOid = (raw: string): number | null => {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;
  return n;
};

/**
 * Coerce a single cell coming back from the protocol layer into a string.
 * Used by the `\lo_list` renderer. Matches the helper in
 * `describe/formatters.ts`.
 */
const cellToString = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf-8');
  if (
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    typeof v === 'bigint'
  ) {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
};

// ---------------------------------------------------------------------------
// \lo_list / \lo_list+
// ---------------------------------------------------------------------------

/**
 * Render the result of `listLargeObjects` through the aligned printer.
 * The query body itself lives in `describe/queries.ts` (WP-20) — we just
 * dispatch to it and feed the result through `alignedPrinter` with the
 * upstream "Large objects" title.
 */
const runLoList = async (
  ctx: BackslashContext,
  verbose: boolean,
): Promise<BackslashResult> => {
  const c = conn(ctx);
  if (!c) return noConn(ctx);
  const query = listLargeObjects({ verbose, serverVersion: c.serverVersion });
  try {
    const rs = await c.query(query.sql, query.params);
    const coerced = {
      ...rs,
      rows: rs.rows.map((row) =>
        row.map((v) =>
          v === null || v === undefined ? null : cellToString(v),
        ),
      ),
    };
    const titleOverride = query.description ?? ctx.settings.popt.title;
    const opts = {
      ...ctx.settings.popt,
      title: titleOverride,
      topt: {
        ...ctx.settings.popt.topt,
        title: titleOverride ?? ctx.settings.popt.topt.title,
      },
    };
    await alignedPrinter.printQuery(coerced, opts, process.stdout);
    return { status: 'ok' };
  } catch (err) {
    writeErr(`\\${ctx.cmdName}: ${errMsg(err)}\n`);
    ctx.settings.lastErrorResult = { message: errMsg(err) };
    return { status: 'error' };
  }
};

/** `\lo_list` — non-verbose listing. */
export const cmdLoList: BackslashCmdSpec = {
  name: 'lo_list',
  helpKey: 'lo_list',
  run: (ctx) => runLoList(ctx, false),
};

/** `\lo_list+` — verbose listing (adds Access privileges column). */
export const cmdLoListPlus: BackslashCmdSpec = {
  name: 'lo_list+',
  helpKey: 'lo_list',
  run: (ctx) => runLoList(ctx, true),
};

// ---------------------------------------------------------------------------
// \lo_import FILE [COMMENT]
// ---------------------------------------------------------------------------

/**
 * `\lo_import FILE [COMMENT]`.
 *
 * Strategy:
 *   1. `fs.readFile(file)` → Buffer.
 *   2. `SELECT pg_catalog.lo_from_bytea(0, $1::bytea)` → new OID. The
 *      bytea param is the file's bytes serialized as `\x<hex>` text.
 *   3. If COMMENT was supplied: `COMMENT ON LARGE OBJECT <oid> IS
 *      '<escaped>'` (single execSimple round-trip, escaped via the
 *      connection's `escapeLiteral`).
 *   4. Print `lo_import <oid>\n` and set the `LASTOID` variable.
 *
 * Errors fall through to the standard `\lo_import: <msg>` diagnostic.
 */
export const cmdLoImport: BackslashCmdSpec = {
  name: 'lo_import',
  helpKey: 'lo_import',
  run: async (ctx) => {
    const c = conn(ctx);
    if (!c) return noConn(ctx);

    const file = ctx.nextArg('normal');
    if (file === null || file.length === 0) {
      writeErr('\\lo_import: missing required argument\n');
      ctx.settings.lastErrorResult = { message: 'missing required argument' };
      return { status: 'error' };
    }
    // Comment is the rest of the line (raw), trimmed. Upstream reads the
    // remaining slash-arg lexed token, but for typical psql usage that
    // means everything after the file is the comment string.
    const commentRaw = ctx.restOfLine().trim();
    const comment = commentRaw.length > 0 ? commentRaw : null;

    let bytes: Buffer;
    try {
      bytes = await fsPromises.readFile(file);
    } catch (err) {
      writeErr(`\\lo_import: ${errMsg(err)}\n`);
      ctx.settings.lastErrorResult = { message: errMsg(err) };
      return { status: 'error' };
    }

    let oidStr: string;
    try {
      const rs = await c.query(
        'SELECT pg_catalog.lo_from_bytea(0, $1::bytea)',
        [byteaText(bytes)],
      );
      if (rs.rows.length === 0) {
        throw new Error('lo_from_bytea returned no rows');
      }
      oidStr = cellToString(rs.rows[0][0]);
      if (!/^\d+$/.test(oidStr)) {
        throw new Error(`lo_from_bytea returned invalid oid: ${oidStr}`);
      }
    } catch (err) {
      writeErr(`\\lo_import: ${errMsg(err)}\n`);
      ctx.settings.lastErrorResult = { message: errMsg(err) };
      return { status: 'error' };
    }

    if (comment !== null) {
      try {
        await c.execSimple(
          `COMMENT ON LARGE OBJECT ${oidStr} IS ${c.escapeLiteral(comment)}`,
        );
      } catch (err) {
        writeErr(`\\lo_import: ${errMsg(err)}\n`);
        ctx.settings.lastErrorResult = { message: errMsg(err) };
        return { status: 'error' };
      }
    }

    // Side effect: set LASTOID (matches upstream `do_lo_import`).
    ctx.settings.vars.set('LASTOID', oidStr);

    writeOut(`lo_import ${oidStr}\n`);
    return { status: 'ok' };
  },
};

// ---------------------------------------------------------------------------
// \lo_export OID FILE
// ---------------------------------------------------------------------------

/**
 * `\lo_export OID FILE`.
 *
 * `SELECT pg_catalog.lo_get($1::oid)` returns a single-row, single-col
 * result whose cell is the LO's bytes. We then `fs.writeFile` to the
 * supplied path. The protocol layer decodes bytea text into a `Buffer`
 * for us when the column oid is bytea; if we get a `\x...` string back
 * we decode it explicitly.
 *
 * Print `lo_export\n` on success — matches upstream `do_lo_export`.
 */
export const cmdLoExport: BackslashCmdSpec = {
  name: 'lo_export',
  helpKey: 'lo_export',
  run: async (ctx) => {
    const c = conn(ctx);
    if (!c) return noConn(ctx);

    const oidArg = ctx.nextArg('normal');
    const file = ctx.nextArg('normal');
    if (oidArg === null || file === null || file.length === 0) {
      writeErr('\\lo_export: missing required argument\n');
      ctx.settings.lastErrorResult = { message: 'missing required argument' };
      return { status: 'error' };
    }
    const oid = parseOid(oidArg);
    if (oid === null) {
      writeErr(`\\lo_export: "${oidArg}" is not a valid large object OID\n`);
      ctx.settings.lastErrorResult = { message: 'invalid OID' };
      return { status: 'error' };
    }

    let bytes: Buffer;
    try {
      const rs = await c.query('SELECT pg_catalog.lo_get($1::oid)', [oid]);
      if (rs.rows.length === 0) {
        throw new Error('lo_get returned no rows');
      }
      const cell = rs.rows[0][0];
      bytes = coerceBytea(cell);
    } catch (err) {
      writeErr(`\\lo_export: ${errMsg(err)}\n`);
      ctx.settings.lastErrorResult = { message: errMsg(err) };
      return { status: 'error' };
    }

    try {
      await fsPromises.writeFile(file, bytes);
    } catch (err) {
      writeErr(`\\lo_export: ${errMsg(err)}\n`);
      ctx.settings.lastErrorResult = { message: errMsg(err) };
      return { status: 'error' };
    }

    writeOut('lo_export\n');
    return { status: 'ok' };
  },
};

/**
 * Decode a bytea cell coming back from the protocol. The connection may
 * deliver:
 *   - a `Buffer` (decoded by a future binary-format path)
 *   - a `\x<hex>` string (text format, modern)
 *   - a legacy `octal-escape` string (text format, pre-9.0 servers; we
 *     don't generate this but it's the historical default).
 */
const coerceBytea = (cell: unknown): Buffer => {
  if (Buffer.isBuffer(cell)) return cell;
  if (typeof cell !== 'string') {
    throw new Error(`lo_get returned unexpected cell type: ${typeof cell}`);
  }
  if (cell.startsWith('\\x')) {
    return Buffer.from(cell.slice(2), 'hex');
  }
  // Legacy octal-escape decode (`\\\\NNN` → byte, `\\\\` → `\\`, others
  // pass through). Upstream `PQunescapeBytea` does the same.
  const out: number[] = [];
  let i = 0;
  while (i < cell.length) {
    if (cell[i] === '\\') {
      if (cell[i + 1] === '\\') {
        out.push(0x5c);
        i += 2;
        continue;
      }
      if (/^[0-7][0-7][0-7]$/.test(cell.slice(i + 1, i + 4))) {
        out.push(parseInt(cell.slice(i + 1, i + 4), 8));
        i += 4;
        continue;
      }
    }
    out.push(cell.charCodeAt(i));
    i++;
  }
  return Buffer.from(out);
};

// ---------------------------------------------------------------------------
// \lo_unlink OID
// ---------------------------------------------------------------------------

/**
 * `\lo_unlink OID` — drop a large object by OID. Implemented via
 * `SELECT pg_catalog.lo_unlink($1::oid)`. The function returns `1` on
 * success or raises an ERROR on missing OID; we just surface either
 * outcome.
 *
 * Print `lo_unlink <oid>\n` on success.
 */
export const cmdLoUnlink: BackslashCmdSpec = {
  name: 'lo_unlink',
  helpKey: 'lo_unlink',
  run: async (ctx) => {
    const c = conn(ctx);
    if (!c) return noConn(ctx);

    const oidArg = ctx.nextArg('normal');
    if (oidArg === null) {
      writeErr('\\lo_unlink: missing required argument\n');
      ctx.settings.lastErrorResult = { message: 'missing required argument' };
      return { status: 'error' };
    }
    const oid = parseOid(oidArg);
    if (oid === null) {
      writeErr(`\\lo_unlink: "${oidArg}" is not a valid large object OID\n`);
      ctx.settings.lastErrorResult = { message: 'invalid OID' };
      return { status: 'error' };
    }

    try {
      await c.query('SELECT pg_catalog.lo_unlink($1::oid)', [oid]);
    } catch (err) {
      writeErr(`\\lo_unlink: ${errMsg(err)}\n`);
      ctx.settings.lastErrorResult = { message: errMsg(err) };
      return { status: 'error' };
    }

    writeOut(`lo_unlink ${String(oid)}\n`);
    return { status: 'ok' };
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the four large-object commands on the supplied registry.
 * Called from `dispatch.ts::defaultRegistry()` (one new line).
 *
 * Note: `\lo_list` and `\lo_list+` shadow the existing `dl::lo_list`
 * alias from `cmd_describe.ts` — the registry's lookup checks primary
 * names before alias mappings, so this registration is the winning one.
 */
export const registerLargeObjectCommands = (
  registry: BackslashRegistry,
): void => {
  registry.register(cmdLoList);
  registry.register(cmdLoListPlus);
  registry.register(cmdLoImport);
  registry.register(cmdLoExport);
  registry.register(cmdLoUnlink);
};
