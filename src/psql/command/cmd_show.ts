/**
 * `\sf [+] FUNCNAME` / `\sv [+] VIEWNAME` show-source commands and their
 * `\ef` / `\ev` edit-form siblings, ported from upstream `command.c`'s
 * `exec_command_sf_sv` and `exec_command_ef_ev`.
 *
 * Behaviour matches upstream byte-for-byte for the show forms:
 *
 *   1. Lookup the object's OID — function via `regproc` (or `regprocedure`
 *      when the name carries an argument list `(int)`), view via `regclass`.
 *   2. Fetch the definition — `pg_get_functiondef(oid)` for functions; for
 *      views we re-assemble the `CREATE OR REPLACE VIEW … AS …` head (with
 *      schema-qualified name, reloptions, and optional `WITH CHECK OPTION`)
 *      around the body returned by `pg_get_viewdef(oid, true)`.
 *   3. Stream the rendered text to `stdout`, optionally prefixed by line
 *      numbers when the user passed `+` (e.g. `\sf+ foo`).
 *
 * Line-number formatting (mirrors upstream `print_with_linenumbers`):
 *
 *   - For functions: lines before the body marker (`AS `, `BEGIN `, or
 *     `RETURN `) are unnumbered and rendered as `        <line>\n` (8 spaces
 *     of padding). Body lines render as `<lineno>      <line>\n` where the
 *     numeric field is left-justified in a 7-character slot, with one
 *     literal space separator. The first body line becomes line 1.
 *   - For views: every line is a "body" line — `lineno` starts at 1 and
 *     increments for every output line, no header padding.
 *
 * Edit forms (`\ef` / `\ev`):
 *   We do not implement editor invocation — that needs TTY interaction and
 *   `$EDITOR` semantics outside the scope of this embedded psql. When the
 *   user supplies a name we route through the same fetch+print path as the
 *   show forms (`\ef foo` ≡ `\sf foo`); without a name we error with a hint
 *   pointing back at `\sf` / `\sv`.
 *
 * Argument parsing matches upstream's `OT_WHOLE_LINE`: we slurp the rest of
 * the line and trim, so `\sf  myschema.foo  ` round-trips cleanly without
 * splitting on the dot or whitespace inside parens.
 */

import type {
  BackslashCmdSpec,
  BackslashContext,
  BackslashRegistry,
  BackslashResult,
} from '../types/backslash.js';
import type { Connection } from '../types/connection.js';

import { writeErr, writeOut } from './shared.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Emit a `\<cmd>: <message>` error to stderr, stash the message on
 * `lastErrorResult` so `\errverbose` / the mainloop fallback see it, and
 * return an error result with `errorWritten: true` so the mainloop doesn't
 * double-print.
 */
const errResult = (ctx: BackslashContext, message: string): BackslashResult => {
  ctx.settings.lastErrorResult = { message };
  writeErr(`\\${ctx.cmdName}: ${message}\n`);
  return { status: 'error', errorWritten: true };
};

/**
 * Format a server error for stderr the way upstream's
 * `minimal_error_message` does: `<severity>:  <primary message>\n`. Falls
 * back to "ERROR:" + Error.message when the error doesn't carry severity /
 * message fields (e.g. a wire-layer rejection).
 */
const formatServerError = (err: unknown): string => {
  if (err && typeof err === 'object') {
    const e = err as { severity?: string; message?: string };
    const sev = e.severity ?? 'ERROR';
    const msg =
      e.message ?? (err instanceof Error ? err.message : safeToString(err));
    return `${sev}:  ${msg}`;
  }
  if (err instanceof Error) return `ERROR:  ${err.message}`;
  return `ERROR:  ${safeToString(err)}`;
};

/**
 * Coerce an unknown value to a string defensively. Plain non-`Error`
 * objects would render as `[object Object]` via the default `String()`
 * path; we sidestep that by JSON-encoding when possible (falls back to
 * the typeof when JSON throws — e.g. circular structures).
 */
const safeToString = (v: unknown): string => {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v;
  if (
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    typeof v === 'bigint'
  ) {
    return String(v);
  }
  try {
    return JSON.stringify(v) ?? typeof v;
  } catch {
    return typeof v;
  }
};

/**
 * Print a server-side query failure the way upstream does — `<sev>:  <msg>`
 * directly on stderr, without the `\<cmd>: ` prefix that local-only errors
 * use. Also stashes the message on `lastErrorResult` so `\errverbose`
 * survives.
 */
const queryErrResult = (
  ctx: BackslashContext,
  err: unknown,
): BackslashResult => {
  const line = formatServerError(err);
  ctx.settings.lastErrorResult = {
    message:
      err && typeof err === 'object' && (err as { message?: string }).message
        ? (err as { message: string }).message
        : err instanceof Error
          ? err.message
          : safeToString(err),
  };
  writeErr(`${line}\n`);
  return { status: 'error', errorWritten: true };
};

const conn = (ctx: BackslashContext): Connection | null => ctx.settings.db;

const noConn = (ctx: BackslashContext): BackslashResult =>
  errResult(ctx, 'no connection to the server');

/**
 * Read the object descriptor as a whole-line argument with surrounding
 * whitespace trimmed. Returns `null` when no name was supplied (after the
 * trim — i.e. `\sf   ` is treated as empty).
 */
const readObjDesc = (ctx: BackslashContext): string | null => {
  const raw = ctx.restOfLine();
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
};

/**
 * Decode whether the command name ends in `+` (request line numbers). The
 * caller knows the base name (`sf`, `sv`, `ef`, `ev`); any extra letters
 * are looked at for a literal `+`.
 */
const decodeShowSuffix = (cmdName: string, base: string): { plus: boolean } => {
  const tail = cmdName.slice(base.length);
  return { plus: tail.includes('+') };
};

/**
 * Look up a function OID from `desc`. Mirrors upstream's
 * `lookup_object_oid(EditableFunction, ...)` exactly:
 *
 *   - If `desc` contains `(`, cast through `regprocedure` (which resolves
 *     by full argument signature, e.g. `foo(int)`).
 *   - Otherwise cast through `regproc` (which matches by bare name and
 *     errors on overloaded ambiguity).
 *
 * The descriptor is passed as a SQL string literal — we use the server's
 * `escapeLiteral` to mirror libpq's `appendStringLiteralConn`.
 */
const lookupFunctionOid = async (
  c: Connection,
  desc: string,
): Promise<{ ok: true; oid: number } | { ok: false; err: unknown }> => {
  const cast = desc.includes('(') ? 'regprocedure' : 'regproc';
  const sql = `SELECT ${c.escapeLiteral(desc)}::pg_catalog.${cast}::pg_catalog.oid`;
  try {
    const rs = await c.query(sql, []);
    if (rs.rows.length !== 1 || rs.rows[0][0] === null) {
      return { ok: false, err: new Error('object lookup returned no rows') };
    }
    const raw = cellToString(rs.rows[0][0]);
    const oid = Number(raw);
    if (!Number.isFinite(oid)) {
      return {
        ok: false,
        err: new Error(`invalid oid in lookup result: ${raw}`),
      };
    }
    return { ok: true, oid };
  } catch (err) {
    return { ok: false, err };
  }
};

/**
 * Look up a view OID from `desc` via `regclass`. Matches upstream's
 * `lookup_object_oid(EditableView, ...)`. Note that this does NOT verify
 * the relation is actually a view; the kind check happens in
 * `getViewCreateCmd` where upstream catches it via the relkind column.
 */
const lookupRelationOid = async (
  c: Connection,
  desc: string,
): Promise<{ ok: true; oid: number } | { ok: false; err: unknown }> => {
  const sql = `SELECT ${c.escapeLiteral(desc)}::pg_catalog.regclass::pg_catalog.oid`;
  try {
    const rs = await c.query(sql, []);
    if (rs.rows.length !== 1 || rs.rows[0][0] === null) {
      return { ok: false, err: new Error('object lookup returned no rows') };
    }
    const raw = cellToString(rs.rows[0][0]);
    const oid = Number(raw);
    if (!Number.isFinite(oid)) {
      return {
        ok: false,
        err: new Error(`invalid oid in lookup result: ${raw}`),
      };
    }
    return { ok: true, oid };
  } catch (err) {
    return { ok: false, err };
  }
};

/**
 * Coerce a wire-layer cell to a string. Text-mode results arrive as
 * strings; null is treated as "" so missing-row paths fall through to
 * empty output instead of crashing.
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
  // Non-primitive fallback: encode JSON so we never emit a stray
  // `[object Object]`. The wire layer hands us strings or nulls in
  // practice, so this branch is defensive only.
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
};

/**
 * Fetch the CREATE FUNCTION source for `oid` via
 * `pg_catalog.pg_get_functiondef(oid)`. Upstream guarantees the result is
 * newline-terminated; we re-assert that here so the caller can stream
 * straight to stdout (or hand to the line-number formatter).
 */
const getFunctionCreateCmd = async (
  c: Connection,
  oid: number,
): Promise<{ ok: true; def: string } | { ok: false; err: unknown }> => {
  const sql = `SELECT pg_catalog.pg_get_functiondef(${oid})`;
  try {
    const rs = await c.query(sql, []);
    if (rs.rows.length !== 1) {
      return { ok: false, err: new Error('function definition not found') };
    }
    let def = cellToString(rs.rows[0][0]);
    if (def.length > 0 && !def.endsWith('\n')) def += '\n';
    return { ok: true, def };
  } catch (err) {
    return { ok: false, err };
  }
};

/**
 * Quote an SQL identifier when needed. Mirrors libpq's `fmtId`: lowercase
 * ASCII identifiers starting with `[a-z_]` and continuing with
 * `[a-z0-9_$]` may go unquoted; anything else gets double-quoted with
 * embedded double-quotes doubled. Used to schema-qualify view names in
 * the synthesised `CREATE OR REPLACE VIEW …` head.
 */
const fmtId = (ident: string): string => {
  if (/^[a-z_][a-z0-9_$]*$/.test(ident) && !RESERVED_WORDS.has(ident)) {
    return ident;
  }
  return `"${ident.replace(/"/g, '""')}"`;
};

/**
 * Minimal reserved-word set used by `fmtId`. Upstream's `fmtId` is much
 * more conservative — any keyword needs quoting regardless of category.
 * For our use case we only quote the keywords that show up as actual
 * relation names; that's vanishingly rare in practice (CREATE VIEW
 * "select" AS … is legal but no one does it). Keeping the set small
 * avoids a large keyword table; the worst case is an un-needed
 * double-quote pair, which is still valid SQL.
 */
const RESERVED_WORDS = new Set<string>([
  'all',
  'analyse',
  'analyze',
  'and',
  'any',
  'array',
  'as',
  'asc',
  'asymmetric',
  'both',
  'case',
  'cast',
  'check',
  'collate',
  'column',
  'constraint',
  'create',
  'current_catalog',
  'current_date',
  'current_role',
  'current_time',
  'current_timestamp',
  'current_user',
  'default',
  'deferrable',
  'desc',
  'distinct',
  'do',
  'else',
  'end',
  'except',
  'false',
  'fetch',
  'for',
  'foreign',
  'from',
  'grant',
  'group',
  'having',
  'in',
  'initially',
  'intersect',
  'into',
  'lateral',
  'leading',
  'limit',
  'localtime',
  'localtimestamp',
  'not',
  'null',
  'offset',
  'on',
  'only',
  'or',
  'order',
  'placing',
  'primary',
  'references',
  'returning',
  'select',
  'session_user',
  'some',
  'symmetric',
  'table',
  'then',
  'to',
  'trailing',
  'true',
  'union',
  'unique',
  'user',
  'using',
  'variadic',
  'when',
  'where',
  'window',
  'with',
]);

/**
 * Re-build a `CREATE OR REPLACE VIEW <schema>.<name>[ WITH (opts)] AS
 * <body>[\n WITH <checkoption> CHECK OPTION]\n` definition the same way
 * upstream's `get_create_object_cmd(EditableView)` does. Returns either
 * the assembled text or a synthetic error when the relation isn't
 * actually a view.
 */
const getViewCreateCmd = async (
  c: Connection,
  oid: number,
): Promise<{ ok: true; def: string } | { ok: false; err: unknown }> => {
  const ver = c.serverVersion >= 90400 ? 'modern' : 'legacy';
  const sql =
    ver === 'modern'
      ? `SELECT nspname, relname, relkind, ` +
        `pg_catalog.pg_get_viewdef(c.oid, true), ` +
        `pg_catalog.array_remove(pg_catalog.array_remove(c.reloptions,'check_option=local'),'check_option=cascaded') AS reloptions, ` +
        `CASE WHEN 'check_option=local' = ANY (c.reloptions) THEN 'LOCAL'::text ` +
        `WHEN 'check_option=cascaded' = ANY (c.reloptions) THEN 'CASCADED'::text ELSE NULL END AS checkoption ` +
        `FROM pg_catalog.pg_class c ` +
        `LEFT JOIN pg_catalog.pg_namespace n ` +
        `ON c.relnamespace = n.oid WHERE c.oid = ${oid}`
      : `SELECT nspname, relname, relkind, ` +
        `pg_catalog.pg_get_viewdef(c.oid, true), ` +
        `c.reloptions AS reloptions, ` +
        `NULL AS checkoption ` +
        `FROM pg_catalog.pg_class c ` +
        `LEFT JOIN pg_catalog.pg_namespace n ` +
        `ON c.relnamespace = n.oid WHERE c.oid = ${oid}`;
  let rs;
  try {
    rs = await c.query(sql, []);
  } catch (err) {
    return { ok: false, err };
  }
  if (rs.rows.length !== 1) {
    return { ok: false, err: new Error('view definition not found') };
  }
  const row = rs.rows[0];
  const nspname = cellToString(row[0]);
  const relname = cellToString(row[1]);
  const relkind = cellToString(row[2]);
  const viewdef = cellToString(row[3]);
  const reloptions = row[4]; // may be string ("{a=b,c=d}") or null
  const checkoption = cellToString(row[5]);

  if (relkind !== 'v') {
    return {
      ok: false,
      err: new Error(`"${nspname}.${relname}" is not a view`),
    };
  }

  let out = 'CREATE OR REPLACE VIEW ';
  out += `${fmtId(nspname)}.${fmtId(relname)}`;

  // reloptions: postgres returns it as a text-mode array literal like
  // `{foo=bar,baz=qux}`; we only need to detect non-empty (different
  // from the literal `{}`) and split entries on `,` outside quotes.
  const reloptStr = reloptions === null ? null : cellToString(reloptions);
  if (reloptStr !== null && reloptStr.length > 2) {
    out += '\n WITH (';
    out += renderReloptions(reloptStr);
    out += ')';
  }

  out += ` AS\n${viewdef}`;

  // Strip trailing semicolon from pg_get_viewdef.
  if (out.endsWith(';')) {
    out = out.slice(0, -1);
  }

  if (checkoption !== '') {
    out += `\n WITH ${checkoption} CHECK OPTION`;
  }

  if (!out.endsWith('\n')) out += '\n';
  return { ok: true, def: out };
};

/**
 * Render a Postgres text-mode array literal of `key=value` reloption
 * entries (e.g. `{security_barrier=true,security_invoker=false}`) into
 * the comma-separated `key=value, key2=value2` form upstream emits
 * inside the `WITH (…)` clause.
 *
 * Mirrors `appendReloptionsArray`'s output behaviour for the limited
 * surface relevant to views (no per-namespace options, no embedded
 * quotes). For any value that contains characters that would need
 * escaping in SQL — anything other than `[A-Za-z0-9_.\-]` — we render
 * it as a quoted string literal, matching upstream's `appendStringLiteral`
 * fallback.
 */
const renderReloptions = (literal: string): string => {
  // Strip surrounding `{}`.
  if (!literal.startsWith('{') || !literal.endsWith('}')) {
    return literal;
  }
  const inside = literal.slice(1, -1);
  if (inside.length === 0) return '';
  // Postgres array literals quote individual elements with `"…"` when
  // they contain commas or special chars. For reloptions on a view the
  // values are typically bare `key=value` strings, but we still need to
  // tolerate the quoted form.
  const entries = splitArrayElems(inside);
  const out: string[] = [];
  for (let entry of entries) {
    // unquote double-quoted entries
    if (entry.startsWith('"') && entry.endsWith('"')) {
      entry = entry.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    const eq = entry.indexOf('=');
    if (eq < 0) {
      out.push(entry);
      continue;
    }
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (/^[A-Za-z0-9_.-]+$/.test(value)) {
      out.push(`${key}=${value}`);
    } else {
      // Quote the value as a SQL string literal.
      out.push(`${key}='${value.replace(/'/g, "''")}'`);
    }
  }
  return out.join(', ');
};

/** Split a Postgres text-mode array's inner content on top-level commas. */
const splitArrayElems = (s: string): string[] => {
  const out: string[] = [];
  let i = 0;
  let cur = '';
  let inQuote = false;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      cur += s[i] + s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
      i++;
      continue;
    }
    if (ch === ',' && !inQuote) {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.length > 0 || s.endsWith(',')) out.push(cur);
  return out;
};

/**
 * Print `buf` with line numbers in the upstream format:
 *
 *   - For functions (`isFunc=true`): scan for the first line whose first
 *     three / six / seven bytes are `AS `, `BEGIN `, or `RETURN ` and
 *     treat that as the start of the body. Header lines (before the
 *     marker) render as `        <line>\n`; body lines render as
 *     `<lineno><6 spaces> <line>\n` (`%-7d %s\n`), with `lineno` starting
 *     at 1 on the marker line.
 *   - For views (`isFunc=false`): everything is body; `lineno` starts at
 *     1 and increments per output line.
 */
const writeWithLineNumbers = (
  buf: string,
  isFunc: boolean,
  out: (s: string) => void,
): void => {
  let inHeader = isFunc;
  let lineno = 0;
  let i = 0;
  while (i < buf.length) {
    // Find end-of-line.
    const eol = buf.indexOf('\n', i);
    const line = eol === -1 ? buf.slice(i) : buf.slice(i, eol);

    if (
      inHeader &&
      (line.startsWith('AS ') ||
        line.startsWith('BEGIN ') ||
        line.startsWith('RETURN '))
    ) {
      inHeader = false;
    }

    if (!inHeader) lineno++;

    if (inHeader) {
      out(`        ${line}\n`);
    } else {
      // %-7d → left-justified, padded to 7. Then literal space, then line.
      const numStr = String(lineno);
      const pad = numStr.length >= 7 ? '' : ' '.repeat(7 - numStr.length);
      out(`${numStr}${pad} ${line}\n`);
    }

    if (eol === -1) break;
    i = eol + 1;
  }
};

/** Stream the definition (with or without line numbers) to stdout. */
const emitDefinition = (def: string, plus: boolean, isFunc: boolean): void => {
  if (plus) {
    writeWithLineNumbers(def, isFunc, writeOut);
  } else {
    writeOut(def);
  }
};

// ---------------------------------------------------------------------------
// Shared core: \sf / \ef (function) and \sv / \ev (view).
// ---------------------------------------------------------------------------

/**
 * Resolve a function/view definition and dump it to stdout. Used by
 * both the show forms (`\sf` / `\sv`) and the edit forms (`\ef` / `\ev`)
 * when the user supplies a name.
 */
const runShowFunction = async (
  ctx: BackslashContext,
  cmdName: string,
  base: 'sf' | 'ef',
): Promise<BackslashResult> => {
  const c = conn(ctx);
  if (!c) return noConn(ctx);
  const { plus } = decodeShowSuffix(cmdName, base);
  const desc = readObjDesc(ctx);
  if (desc === null) {
    return errResult(ctx, 'function name is required');
  }
  const oidLookup = await lookupFunctionOid(c, desc);
  if (!oidLookup.ok) return queryErrResult(ctx, oidLookup.err);
  const defLookup = await getFunctionCreateCmd(c, oidLookup.oid);
  if (!defLookup.ok) return queryErrResult(ctx, defLookup.err);
  emitDefinition(defLookup.def, plus, /*isFunc=*/ true);
  return { status: 'ok' };
};

const runShowView = async (
  ctx: BackslashContext,
  cmdName: string,
  base: 'sv' | 'ev',
): Promise<BackslashResult> => {
  const c = conn(ctx);
  if (!c) return noConn(ctx);
  const { plus } = decodeShowSuffix(cmdName, base);
  const desc = readObjDesc(ctx);
  if (desc === null) {
    return errResult(ctx, 'view name is required');
  }
  const oidLookup = await lookupRelationOid(c, desc);
  if (!oidLookup.ok) return queryErrResult(ctx, oidLookup.err);
  const defLookup = await getViewCreateCmd(c, oidLookup.oid);
  if (!defLookup.ok) return queryErrResult(ctx, defLookup.err);
  emitDefinition(defLookup.def, plus, /*isFunc=*/ false);
  return { status: 'ok' };
};

// ---------------------------------------------------------------------------
// BackslashCmdSpec exports
// ---------------------------------------------------------------------------

/** `\sf [+] FUNCNAME` — show function source. */
export const cmdShowFunction: BackslashCmdSpec = {
  name: 'sf',
  argMode: 'whole-line',
  helpKey: 'sf',
  run: (ctx) => runShowFunction(ctx, ctx.cmdName, 'sf'),
};

/** `\sf+ FUNCNAME` — show function source with line numbers. */
export const cmdShowFunctionPlus: BackslashCmdSpec = {
  name: 'sf+',
  argMode: 'whole-line',
  helpKey: 'sf',
  run: (ctx) => runShowFunction(ctx, ctx.cmdName, 'sf'),
};

/** `\sv [+] VIEWNAME` — show view source. */
export const cmdShowView: BackslashCmdSpec = {
  name: 'sv',
  argMode: 'whole-line',
  helpKey: 'sv',
  run: (ctx) => runShowView(ctx, ctx.cmdName, 'sv'),
};

/** `\sv+ VIEWNAME` — show view source with line numbers. */
export const cmdShowViewPlus: BackslashCmdSpec = {
  name: 'sv+',
  argMode: 'whole-line',
  helpKey: 'sv',
  run: (ctx) => runShowView(ctx, ctx.cmdName, 'sv'),
};

/**
 * `\ef [+] [FUNCNAME [LINE]]` — upstream opens `$EDITOR` on the function's
 * source. We don't implement editor invocation; when a name is supplied we
 * route through the same fetch+print path as `\sf` (with a stripped line
 * number — the trailing LINE argument is ignored). Without a name we error
 * with a hint pointing at `\sf`.
 */
export const cmdEditFunction: BackslashCmdSpec = {
  name: 'ef',
  argMode: 'whole-line',
  helpKey: 'ef',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { plus } = decodeShowSuffix(ctx.cmdName, 'ef');
    const desc = readObjDesc(ctx);
    if (desc === null) {
      return errResult(
        ctx,
        'editing not supported in embedded psql; supply a name to display the source',
      );
    }
    // Strip a possible trailing LINE number (upstream behaviour for \ef
    // FUNCNAME LINE — the editor opens at that line; we just discard it).
    const objDesc = stripTrailingLine(desc);
    const oidLookup = await lookupFunctionOid(c, objDesc);
    if (!oidLookup.ok) return queryErrResult(ctx, oidLookup.err);
    const defLookup = await getFunctionCreateCmd(c, oidLookup.oid);
    if (!defLookup.ok) return queryErrResult(ctx, defLookup.err);
    emitDefinition(defLookup.def, plus, /*isFunc=*/ true);
    return { status: 'ok' };
  },
};

/**
 * `\ev [+] [VIEWNAME [LINE]]` — same contract as `\ef` but for views.
 */
export const cmdEditView: BackslashCmdSpec = {
  name: 'ev',
  argMode: 'whole-line',
  helpKey: 'ev',
  async run(ctx: BackslashContext): Promise<BackslashResult> {
    const c = conn(ctx);
    if (!c) return noConn(ctx);
    const { plus } = decodeShowSuffix(ctx.cmdName, 'ev');
    const desc = readObjDesc(ctx);
    if (desc === null) {
      return errResult(
        ctx,
        'editing not supported in embedded psql; supply a name to display the source',
      );
    }
    const objDesc = stripTrailingLine(desc);
    const oidLookup = await lookupRelationOid(c, objDesc);
    if (!oidLookup.ok) return queryErrResult(ctx, oidLookup.err);
    const defLookup = await getViewCreateCmd(c, oidLookup.oid);
    if (!defLookup.ok) return queryErrResult(ctx, defLookup.err);
    emitDefinition(defLookup.def, plus, /*isFunc=*/ false);
    return { status: 'ok' };
  },
};

/**
 * Aliases so that `\ef+` and `\ev+` resolve to the corresponding command;
 * we register the plus variants explicitly because the registry is keyed
 * by full name.
 */
export const cmdEditFunctionPlus: BackslashCmdSpec = {
  ...cmdEditFunction,
  name: 'ef+',
};
export const cmdEditViewPlus: BackslashCmdSpec = {
  ...cmdEditView,
  name: 'ev+',
};

/**
 * Strip a trailing LINE number from an object descriptor, matching
 * upstream's `strip_lineno_from_objdesc`. We rebuild the simpler subset
 * here because the slash-arg scanner already handed us a single trimmed
 * whole-line string: if it ends with `<digits>` separated from the
 * preceding name by whitespace or `)`, strip the digits.
 *
 * Returns the descriptor with any trailing line number removed. Invalid
 * line numbers (zero) are not detected here — we treat them the same as
 * "no line number" because the LINE arg is meaningless to our
 * show-only impl.
 */
const stripTrailingLine = (desc: string): string => {
  let i = desc.length - 1;
  while (i > 0 && /\s/.test(desc[i])) i--;
  if (i <= 0 || !/[0-9]/.test(desc[i])) return desc;
  while (i > 0 && /[0-9]/.test(desc[i])) i--;
  // The char before the digit run must be whitespace or `)` and not the
  // very first char.
  if (i <= 0) return desc;
  const sep = desc[i];
  if (!(/\s/.test(sep) || sep === ')')) return desc;
  return desc.slice(0, i + 1).trimEnd();
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register `\sf`, `\sf+`, `\sv`, `\sv+`, `\ef`, `\ef+`, `\ev`, `\ev+` on
 * the supplied registry. Wired into `defaultRegistry()` from `dispatch.ts`.
 */
export const registerShowCommands = (registry: BackslashRegistry): void => {
  registry.register(cmdShowFunction);
  registry.register(cmdShowFunctionPlus);
  registry.register(cmdShowView);
  registry.register(cmdShowViewPlus);
  registry.register(cmdEditFunction);
  registry.register(cmdEditFunctionPlus);
  registry.register(cmdEditView);
  registry.register(cmdEditViewPlus);
};
