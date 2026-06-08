/**
 * psql `\crosstabview` pivot + render (WP-22).
 *
 * TypeScript port of `src/bin/psql/crosstabview.c`:
 *
 *   - `pivotResultSet` is the moral equivalent of `PrintResultInCrosstab`'s
 *     "first/second/third part" — resolve the four column references against
 *     the source ResultSet's fields, collect the distinct vertical / horizontal
 *     header values (in first-appearance order, matching upstream's AVL-tree
 *     `rank = tree->count` assignment), detect duplicate `(colV, colH)` pairs,
 *     and produce a new ResultSet whose first column is the vertical header
 *     and whose remaining columns are one per horizontal-header value.
 *
 *   - `printCrosstab` runs the pivot and then forwards the pivoted ResultSet
 *     to the existing aligned printer (`alignedPrinter.printQuery`). We
 *     deliberately reuse the aligned printer so border / nullPrint / locale /
 *     unicode glyphs / expanded all keep working without re-implementation.
 *
 * Column references accept upstream's two forms — a 1-based column number
 * (`"1"`, `"2"`, ...) and a column name (matched against `ResultSet.fields`
 * using upstream's "dequote then downcase" rule). The fourth argument
 * (`sortColH`) additionally honours a leading `+` / `-` to request
 * ascending / descending sort on the horizontal header values — a small
 * extension over upstream's "sort by the sort-column's payload" semantics
 * that lets callers pivot without an explicit numeric sort column.
 *
 * Error cases (text matches `pg_log_error` strings from crosstabview.c):
 *
 *   - "query must return at least three columns",
 *   - "vertical and horizontal headers must be different columns",
 *   - "column number N is out of range 1..M",
 *   - "column name not found: \"…\"",
 *   - "ambiguous column name: \"…\"",
 *   - "maximum number of columns (1600) exceeded",
 *   - "query result contains multiple data values for row \"…\", column \"…\"".
 */

import type { FieldDescription, ResultSet } from '../types/connection.js';
import type { PrintQueryOpts } from '../types/printer.js';

import { alignedPrinter } from './aligned.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CrosstabOptions = {
  colV?: string | number;
  colH?: string | number;
  colD?: string | number;
  /** Sort key for horizontal headers. Leading `-` (or a negative number) flips to descending. */
  sortColH?: string | number;
};

export type CrosstabError = { error: string };

// ---------------------------------------------------------------------------
// Column-reference resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a single column reference (1-based index or name) to a zero-based
 * column index in `fields`. Mirrors upstream's `indexOfColumn`:
 *
 *  - If the arg is all digits, parse as 1-based and bounds-check.
 *  - Otherwise, dequote + downcase the name (`dequote_downcase_identifier`)
 *    and match it case-insensitively against the field names. Returns an
 *    error if no match or if more than one field matches.
 *
 * `sign` is returned alongside the index so that callers using this for the
 * `sortColH` argument can pick up the leading `+`/`-` decoration as a sort
 * direction. For non-sort columns, callers ignore `sign` (and `-1` is treated
 * as an out-of-range column number, matching upstream).
 */
type IndexResult =
  | { ok: true; index: number; sign: 1 | -1 }
  | { ok: false; error: string };

const DIGIT_RE = /^\d+$/;
const SIGNED_DIGIT_RE = /^[+-]?\d+$/;

/**
 * Strip `"…"` quoting and downcase unquoted runs. Mirrors psql's
 * `dequote_downcase_identifier` (in-place: only unquoted bytes are
 * downcased). Returns both the dequoted string and whether ANY part of
 * the input was inside quotes — callers use the latter to decide between
 * strcmp (quoted ⇒ exact match) and a case-insensitive fallback.
 */
type Dequoted = { value: string; hadQuotes: boolean };
const dequoteDowncase = (raw: string): Dequoted => {
  let out = '';
  let inquotes = false;
  let hadQuotes = false;
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') {
      hadQuotes = true;
      if (inquotes && raw[i + 1] === '"') {
        out += '"';
        i += 2;
        continue;
      }
      inquotes = !inquotes;
      i++;
      continue;
    }
    out += inquotes ? c : c.toLowerCase();
    i++;
  }
  return { value: out, hadQuotes };
};

const indexOfColumn = (
  arg: string | number,
  fields: FieldDescription[],
  allowSign: boolean,
): IndexResult => {
  // Numeric arg path: number type, or string that parses as integer.
  if (typeof arg === 'number') {
    if (!Number.isInteger(arg)) {
      return {
        ok: false,
        error: `column number ${String(arg)} is not an integer`,
      };
    }
    const sign: 1 | -1 = arg < 0 ? -1 : 1;
    const abs = Math.abs(arg);
    if (abs < 1 || abs > fields.length) {
      return {
        ok: false,
        error: `column number ${String(abs)} is out of range 1..${String(fields.length)}`,
      };
    }
    return { ok: true, index: abs - 1, sign: allowSign ? sign : 1 };
  }

  let str = arg.trim();
  let sign: 1 | -1 = 1;
  if (allowSign && (str.startsWith('+') || str.startsWith('-'))) {
    if (str.startsWith('-')) sign = -1;
    // Peel only when the rest looks like it could be a referencing token.
    const rest = str.slice(1);
    if (rest.length > 0) str = rest;
  }

  if (str.length === 0) {
    return { ok: false, error: 'empty column reference' };
  }

  if (DIGIT_RE.test(str)) {
    const n = parseInt(str, 10);
    if (n < 1 || n > fields.length) {
      return {
        ok: false,
        error: `column number ${String(n)} is out of range 1..${String(fields.length)}`,
      };
    }
    return { ok: true, index: n - 1, sign };
  }

  // Name lookup: upstream `indexOfColumn` dequotes & downcases the arg
  // in place, then runs `strcmp(arg, PQfname(res, i))` against the raw
  // field name. The field name is NOT itself downcased, so:
  //   - unquoted `B` → "b" → matches field `b` only (not `B`);
  //   - unquoted `Foo` → "foo" → does NOT match field `Foo`;
  //   - quoted `"B"` → "B" → matches field `B` only;
  //   - quoted `"Foo"` → "Foo" → matches field `Foo`.
  // No case-insensitive fallback — that mismatched the
  // "need to quote name" test in the conformance corpus.
  const { value: needle } = dequoteDowncase(str);
  let found = -1;
  for (let i = 0; i < fields.length; i++) {
    if (fields[i].name === needle) {
      if (found >= 0) {
        // Upstream's `indexOfColumn` formats the dequoted/downcased name
        // in the error message, not the raw arg with its leading
        // quotes. Matches `pg_log_error("ambiguous column name: \"%s\"")`
        // after the in-place `dequote_downcase_identifier(arg)` mutation.
        return { ok: false, error: `ambiguous column name: "${needle}"` };
      }
      found = i;
    }
  }
  if (found === -1) {
    // Same convention as the ambiguous-name branch: format the
    // dequoted/downcased name so quoted `"B"` reads as `"B"` and
    // unquoted `Foo` reads as `"foo"`.
    return { ok: false, error: `column name not found: "${needle}"` };
  }
  return { ok: true, index: found, sign };
};

// ---------------------------------------------------------------------------
// Cell value → comparable key + display string
// ---------------------------------------------------------------------------

/**
 * Build a stable string key for a header value so we can deduplicate
 * vertical / horizontal headers consistently. We use `JSON.stringify`-ish
 * encoding plus a leading discriminator so e.g. the string `"1"` and the
 * number `1` don't collide (matches upstream where PQgetvalue returns a
 * type-specific text form — the rows pre-serialised by the server are
 * compared byte-for-byte).
 *
 * Null is represented by a sentinel so the printer can substitute
 * `popt.nullPrint`.
 */
const NULL_SENTINEL = Symbol.for('neonctl.psql.crosstab.null');
type HeaderKey = string | typeof NULL_SENTINEL;

const headerKey = (value: unknown): HeaderKey => {
  if (value === null || value === undefined) return NULL_SENTINEL;
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'number') return `n:${String(value)}`;
  if (typeof value === 'bigint') return `i:${String(value)}`;
  if (typeof value === 'boolean') return `b:${String(value)}`;
  if (value instanceof Date) return `d:${value.toISOString()}`;
  if (value instanceof Uint8Array) {
    let hex = 'x:';
    for (const b of value) hex += b.toString(16).padStart(2, '0');
    return hex;
  }
  return `j:${JSON.stringify(value)}`;
};

/**
 * Display form for a header value — used to populate the synthetic
 * ResultSet's `fields[i].name` (which must be a string, not nullable).
 * Mirrors upstream's `colname = piv_columns[…].name ? … : popt.nullPrint`.
 */
const headerDisplay = (value: unknown, nullPrint: string): string => {
  if (value === null || value === undefined) return nullPrint;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    let hex = '\\x';
    for (const b of value) hex += b.toString(16).padStart(2, '0');
    return hex;
  }
  return JSON.stringify(value);
};

// ---------------------------------------------------------------------------
// Pivot
// ---------------------------------------------------------------------------

type HeaderEntry = {
  key: HeaderKey;
  /** Original cell value, for headerDisplay / data lookup. */
  value: unknown;
  /** First-appearance rank (0-based). */
  rank: number;
  /** Sort-column value captured at first appearance of this header. */
  sortValue: unknown;
};

/**
 * Compare two cells under `+`/`-` numeric semantics: if both look like
 * `/^-?\d+$/` (matching upstream's `rankSort` regex), compare as integers;
 * otherwise compare as strings. Nulls sort last. The `sign` flag flips the
 * order (descending).
 */
const cmpForSort = (a: unknown, b: unknown, sign: 1 | -1): number => {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1; // null last
  if (bNull) return -1;

  const aStr = typeof a === 'string' ? a : headerDisplay(a, '');
  const bStr = typeof b === 'string' ? b : headerDisplay(b, '');
  if (SIGNED_DIGIT_RE.test(aStr) && SIGNED_DIGIT_RE.test(bStr)) {
    const an = parseInt(aStr, 10);
    const bn = parseInt(bStr, 10);
    if (an < bn) return -1 * sign;
    if (an > bn) return 1 * sign;
    return 0;
  }
  if (aStr < bStr) return -1 * sign;
  if (aStr > bStr) return 1 * sign;
  return 0;
};

export type PivotResult = { rs: ResultSet };

/**
 * Pivot a ResultSet into a `{ rowHeaders, colHeaders, matrix }` shape,
 * returning a synthetic ResultSet ready for the aligned printer.
 *
 * Detailed algorithm:
 *
 *  1. Resolve `colV` / `colH` / `colD` / `sortColH` to zero-based field
 *     indices via {@link indexOfColumn}. `colV` defaults to 0, `colH` to 1.
 *     `colD` defaults to the only remaining column when there are exactly
 *     three; otherwise we require it explicitly (matching upstream).
 *  2. Walk rows once. For each row:
 *       - `vKey` = header-key of the row's colV cell;
 *       - `hKey` = header-key of the row's colH cell;
 *       - If we haven't seen `vKey` or `hKey` before, give them the next
 *         rank in first-appearance order, and capture the sort value
 *         (from colSort) for hKey.
 *       - Stash the cell at `(vRank, hRank)`. If a value already lives
 *         there, surface a duplicate-pair error.
 *  3. If `sortColH` was supplied, stable-sort the horizontal header entries
 *     by their captured sort value (numeric if both look numeric, else
 *     string; `sign` for ascending/descending) and reassign ranks.
 *  4. Construct the synthetic ResultSet: one field for colV (carries colV's
 *     original FieldDescription) + one field per horizontal header value
 *     (each carrying colD's FieldDescription, so the aligned printer's
 *     right-align heuristic kicks in for numeric data).
 *  5. Rows: for each vertical header in rank order, emit `[vHeaderValue,
 *     ...cellsByHorizontalRank]`. Unfilled cells are `""` so the printer
 *     just emits empty padding (matching upstream's
 *     "non-initialized cells must be set to an empty string" pass).
 */
export const pivotResultSet = (
  rs: ResultSet,
  opts: CrosstabOptions,
  /**
   * Substitution string for `null` header values when synthesising the
   * pivoted FieldDescription.name. Upstream's `\crosstabview` formats a
   * NULL horizontal header using the current `\pset null` setting (an
   * empty string by default). Callers that don't care can omit; tests
   * that drive the function in isolation can supply a sentinel.
   */
  nullPrint = '',
): PivotResult | CrosstabError => {
  // (1) Field resolution. Upstream `crosstabview.c` requires PQnfields >= 3
  // unconditionally — pivoting two columns is degenerate (V × H with no
  // payload). Match the error text verbatim so the conformance test sees
  // the same line.
  if (rs.fields.length < 3) {
    return { error: 'query must return at least three columns' };
  }

  const colV = opts.colV ?? 1;
  const colH = opts.colH ?? 2;

  const vRes = indexOfColumn(colV, rs.fields, false);
  if (!vRes.ok) return { error: vRes.error };
  const hRes = indexOfColumn(colH, rs.fields, false);
  if (!hRes.ok) return { error: hRes.error };

  if (vRes.index === hRes.index) {
    return {
      error: 'vertical and horizontal headers must be different columns',
    };
  }

  let dataIdx: number;
  if (opts.colD === undefined) {
    // With exactly three columns and no explicit `colD`, the data column
    // is the remaining one. With more than three, upstream picks the
    // first non-V/H column too — we mirror that here so `SELECT v,h,c,i`
    // pivots `c` by default.
    let candidate = -1;
    for (let i = 0; i < rs.fields.length; i++) {
      if (i !== vRes.index && i !== hRes.index) {
        candidate = i;
        break;
      }
    }
    if (candidate < 0) {
      return { error: 'no data column available' };
    }
    dataIdx = candidate;
  } else {
    const dRes = indexOfColumn(opts.colD, rs.fields, false);
    if (!dRes.ok) return { error: dRes.error };
    dataIdx = dRes.index;
  }

  let sortIdx = -1;
  let sortSign: 1 | -1 = 1;
  if (opts.sortColH !== undefined) {
    const sRes = indexOfColumn(opts.sortColH, rs.fields, true);
    if (!sRes.ok) return { error: sRes.error };
    sortIdx = sRes.index;
    sortSign = sRes.sign;
  }

  // (2) Single-pass row walk: build distinct V/H header sets in
  // first-appearance order and populate the data matrix.
  const vHeaders = new Map<HeaderKey, HeaderEntry>();
  const hHeaders = new Map<HeaderKey, HeaderEntry>();

  // matrix keyed by `${vRank}|${hRank}` rather than a 2D array because we
  // don't know the final dimensions until we've walked all rows. The
  // string key keeps lookups O(1) without packing into an array.
  const matrix = new Map<string, unknown>();

  for (const row of rs.rows) {
    const vVal = row[vRes.index];
    const hVal = row[hRes.index];
    const dVal = row[dataIdx];

    const vk = headerKey(vVal);
    const hk = headerKey(hVal);

    let vEntry = vHeaders.get(vk);
    if (!vEntry) {
      vEntry = {
        key: vk,
        value: vVal,
        rank: vHeaders.size,
        sortValue: null,
      };
      vHeaders.set(vk, vEntry);
    }

    let hEntry = hHeaders.get(hk);
    if (!hEntry) {
      // Upstream `crosstabview.c` caps distinct horizontal-header values
      // at `CROSSTABVIEW_MAX_COLUMNS` (1600). Past that, the synthesised
      // result wouldn't be printable in a reasonable width anyway, so
      // we mirror the cap and the error text verbatim.
      if (hHeaders.size >= 1600) {
        return { error: 'maximum number of columns (1600) exceeded' };
      }
      hEntry = {
        key: hk,
        value: hVal,
        rank: hHeaders.size,
        sortValue: sortIdx >= 0 ? row[sortIdx] : null,
      };
      hHeaders.set(hk, hEntry);
    }

    const cellKey = `${String(vEntry.rank)}|${String(hEntry.rank)}`;
    if (matrix.has(cellKey)) {
      const vDisp = headerDisplay(vEntry.value, '(null)');
      const hDisp = headerDisplay(hEntry.value, '(null)');
      return {
        error: `query result contains multiple data values for row "${vDisp}", column "${hDisp}"`,
      };
    }
    matrix.set(cellKey, dVal);
  }

  // (3) Sort horizontal headers if requested. We stable-sort by capturing
  // the original rank to break ties (and by using Array.prototype.sort
  // which is stable in V8/Node).
  //
  // We deliberately DO NOT mutate `HeaderEntry.rank` here — the matrix is
  // keyed by `${vRank}|${origHRank}` and changing `hArr[i].rank` to the
  // post-sort position would desynchronise lookups in step 5. Display
  // order is carried implicitly by the array index.
  const hArr = Array.from(hHeaders.values());
  if (sortIdx >= 0) {
    hArr.sort((a, b) => {
      const c = cmpForSort(a.sortValue, b.sortValue, sortSign);
      if (c !== 0) return c;
      // Tie-break on first-appearance rank to keep ordering deterministic.
      return a.rank - b.rank;
    });
  }

  const vArr = Array.from(vHeaders.values()).sort((a, b) => a.rank - b.rank);

  // (4) Build the synthetic ResultSet. Use the caller-supplied
  // `nullPrint` for any horizontal header whose source value was NULL —
  // upstream `do_crosstabview` calls `PQgetvalue(res, …)` which returns
  // the empty string for null, but then formats the header through
  // `popt.nullPrint` when the source cell was actually null. Pass the
  // active `\pset null` string in so `--null='#null#'` lights up the
  // last column header on a pivot with a NULL H value.
  const newFields: FieldDescription[] = [
    {
      ...rs.fields[vRes.index],
      // Keep colV's name as-is for the row-header column.
    },
    ...hArr.map((h) => ({
      ...rs.fields[dataIdx],
      // Headers come from H values; we serialise to strings so the
      // FieldDescription.name contract (string, not unknown) is satisfied.
      name: headerDisplay(h.value, nullPrint),
    })),
  ];

  // (5) Emit rows in vertical-header rank order. Each row is
  // [vHeaderValue, ...cellsByHorizontalRank]. Unfilled cells become "".
  const newRows: unknown[][] = vArr.map((v) => {
    const row: unknown[] = new Array<unknown>(hArr.length + 1);
    row[0] = v.value;
    for (let i = 0; i < hArr.length; i++) {
      const key = `${String(v.rank)}|${String(hArr[i].rank)}`;
      // Unfilled cells: empty string so the aligned printer emits nothing
      // (rather than substituting nullPrint). Matches upstream's
      // "non-initialized cells must be set to an empty string" pass.
      row[i + 1] = matrix.has(key) ? matrix.get(key) : '';
    }
    return row;
  });

  const synthetic: ResultSet = {
    command: rs.command,
    rowCount: vArr.length,
    oid: null,
    fields: newFields,
    rows: newRows,
    notices: [],
  };

  return { rs: synthetic };
};

// ---------------------------------------------------------------------------
// printCrosstab — pivot + delegate to alignedPrinter
// ---------------------------------------------------------------------------

/**
 * High-level entry: pivot `rs` per `opts`, then forward the synthetic
 * ResultSet to `alignedPrinter.printQuery`. Returns a `CrosstabError` if
 * pivoting fails; on success returns `undefined` (matching the rest of the
 * `print/` API surface).
 *
 * We deliberately use the aligned printer regardless of `printOpts.topt.format`:
 * upstream psql's `\crosstabview` always renders through the table printer
 * (it ignores `\pset format` for the duration of the call), and our tests
 * lean on the aligned printer's borders / nullPrint / numericLocale handling
 * matching exactly.
 */
export const printCrosstab = async (
  rs: ResultSet,
  opts: CrosstabOptions,
  printOpts: PrintQueryOpts,
  out: NodeJS.WritableStream,
): Promise<CrosstabError | undefined> => {
  // Thread the active `\pset null` value through so a NULL horizontal
  // header renders as e.g. `#null#` in the column header row (mirroring
  // the way the aligned printer would otherwise render it for a body
  // cell). Without this, the synthetic FieldDescription.name comes out
  // as the empty string and the column header is just whitespace.
  const result = pivotResultSet(rs, opts, printOpts.topt.nullPrint);
  if ('error' in result) return result;
  await alignedPrinter.printQuery(result.rs, printOpts, out);
  return undefined;
};
