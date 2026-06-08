import type { ResultSet } from '../types/connection.js';
import type { PrintQueryOpts, Printer } from '../types/printer.js';

import { formatNumericLocale } from './units.js';

/**
 * AsciiDoc printer.
 *
 * Mirrors print.c `print_asciidoc_text` and `print_asciidoc_vertical`.
 *
 * Output shape (flat):
 *   .title
 *   [options="header",cols="<l,<l,>l",frame="all",grid="all"]
 *   |====
 *   ^l|col1 ^l|col2 ^l|col3
 *   |val1 |val2 |val3
 *   |====
 *
 *   ....
 *   (N rows)
 *   ....
 *
 * Output shape (expanded, `\pset expanded on`):
 *   .title
 *   [cols="h,l",frame="all",grid="all"]
 *   |====
 *   2+^|Record 1
 *   <l|col1 <l|val1
 *   <l|col2 >l|val2
 *   ...
 *   |====
 *   (no row count footer)
 *
 * - `topt.border`:
 *     0 → `,frame="none",grid="none"`
 *     1 → `,frame="none"`
 *     2 → `,frame="all",grid="all"`
 *   Borders outside 0..2 fall back to "no extra clause" (matches the
 *   switch with no default in print.c).
 * - Numeric columns (per the OID heuristic) get `>l`, others `<l`.
 *   Headers in flat mode are centered with `^l|`. In expanded mode
 *   header cells render with `<l|` and value cells use the alignment
 *   letter from the data column.
 * - AsciiDoc's only structurally hostile character is `|` (it ends a
 *   cell), so the escape helper only rewrites that to `\|`. Newlines
 *   pass through — AsciiDoc continues a cell over an embedded newline.
 * - Whitespace-only cells are emitted as just `|` (with a trailing
 *   space for inter-cell separation), matching the upstream
 *   "protect against needless spaces" branch.
 * - Expanded mode never emits the `(N rows)` footer; only user-set
 *   footers appear (matches upstream `print_asciidoc_vertical`).
 */

// INT2, INT4, INT8, FLOAT4, FLOAT8, NUMERIC, INTERVAL.
const NUMERIC_OIDS = new Set<number>([21, 23, 20, 700, 701, 1700, 1186]);

export const asciidocPrinter: Printer = {
  format: 'asciidoc',
  printQuery(
    rs: ResultSet,
    opts: PrintQueryOpts,
    out: NodeJS.WritableStream,
  ): Promise<void> {
    const topt = opts.topt;
    if (topt.expanded === 'on') {
      return printExpanded(rs, opts, out);
    }
    return printFlat(rs, opts, out);
  },
};

const printFlat = (
  rs: ResultSet,
  opts: PrintQueryOpts,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const topt = opts.topt;
  const tuplesOnly = topt.tuplesOnly;
  const startTable = topt.startTable;
  const stopTable = topt.stopTable;
  const nullPrint = opts.nullPrint !== '' ? opts.nullPrint : topt.nullPrint;
  const title = opts.title ?? topt.title;
  const footers = opts.footers ?? topt.footers;

  const headers = rs.fields.map((f) => f.name);
  const aligns: ('l' | 'r')[] = rs.fields.map((f) =>
    NUMERIC_OIDS.has(f.dataTypeID) ? 'r' : 'l',
  );
  const ncols = rs.fields.length;
  const cells: string[][] = rs.rows.map((row) =>
    row.map((cell) => renderCell(cell, nullPrint, topt.numericLocale)),
  );

  let buf = '';

  if (startTable) {
    // Force a paragraph break (upstream always emits a leading "\n").
    buf += '\n';

    if (!tuplesOnly && title) {
      buf += '.' + title + '\n';
    }

    buf += '[';
    if (!tuplesOnly) buf += 'options="header",';
    buf += 'cols="';
    buf += aligns.map((a) => (a === 'r' ? '>l' : '<l')).join(',');
    buf += '"';
    buf += borderClause(topt.border);
    buf += ']\n';
    buf += '|====\n';

    if (!tuplesOnly) {
      headers.forEach((h, idx) => {
        if (idx !== 0) buf += ' ';
        buf += '^l|' + escapeAsciidoc(h);
      });
      buf += '\n';
    }
  }

  for (const row of cells) {
    row.forEach((value, idx) => {
      if (idx !== 0) buf += ' ';
      buf += '|';
      if (isWhitespaceOnly(value)) {
        // The upstream code emits a trailing space only for cells
        // that are not the last in their row.
        if (idx !== ncols - 1) buf += ' ';
      } else {
        buf += escapeAsciidoc(value);
      }
    });
    buf += '\n';
  }

  buf += '|====\n';

  if (stopTable && !tuplesOnly) {
    const effective = effectiveFooters(rs, topt, footers);
    if (effective.length > 0) {
      buf += '\n....\n';
      for (const f of effective) buf += f + '\n';
      buf += '....\n';
    }
  }

  out.write(buf);
  return Promise.resolve();
};

const printExpanded = (
  rs: ResultSet,
  opts: PrintQueryOpts,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const topt = opts.topt;
  const tuplesOnly = topt.tuplesOnly;
  const startTable = topt.startTable;
  const stopTable = topt.stopTable;
  const nullPrint = opts.nullPrint !== '' ? opts.nullPrint : topt.nullPrint;
  const title = opts.title ?? topt.title;
  const footers = opts.footers ?? topt.footers;

  const headers = rs.fields.map((f) => f.name);
  const aligns: ('l' | 'r')[] = rs.fields.map((f) =>
    NUMERIC_OIDS.has(f.dataTypeID) ? 'r' : 'l',
  );
  const cells: string[][] = rs.rows.map((row) =>
    row.map((cell) => renderCell(cell, nullPrint, topt.numericLocale)),
  );

  let buf = '';

  if (startTable) {
    buf += '\n';

    if (!tuplesOnly && title) {
      buf += '.' + title + '\n';
    }

    buf += '[cols="h,l"';
    buf += borderClause(topt.border);
    buf += ']\n';
    buf += '|====\n';
  }

  let record = topt.prior + 1;
  cells.forEach((row) => {
    if (!tuplesOnly) {
      buf += `2+^|Record ${String(record)}\n`;
      record += 1;
    } else {
      buf += '2+|\n';
    }
    row.forEach((value, idx) => {
      buf += '<l|' + escapeAsciidoc(headers[idx]);
      buf += ' ' + (aligns[idx] === 'r' ? '>l' : '<l') + '|';
      if (isWhitespaceOnly(value)) {
        buf += ' ';
      } else {
        buf += escapeAsciidoc(value);
      }
      buf += '\n';
    });
  });

  buf += '|====\n';

  if (stopTable && !tuplesOnly) {
    // Expanded mode does NOT emit the default "(N rows)" footer —
    // only user-supplied footers (matches print_asciidoc_vertical).
    if (footers && footers.length > 0) {
      buf += '\n....\n';
      for (const f of footers) buf += f + '\n';
      buf += '....\n';
    }
  }

  out.write(buf);
  return Promise.resolve();
};

const borderClause = (border: number): string => {
  switch (border) {
    case 0:
      return ',frame="none",grid="none"';
    case 1:
      return ',frame="none"';
    case 2:
      return ',frame="all",grid="all"';
    default:
      return '';
  }
};

const effectiveFooters = (
  rs: ResultSet,
  topt: { defaultFooter: boolean },
  footers: string[] | null,
): string[] => {
  if (footers && footers.length > 0) return footers;
  if (topt.defaultFooter) {
    const n = rs.rows.length;
    return [`(${String(n)} ${n === 1 ? 'row' : 'rows'})`];
  }
  return [];
};

const isWhitespaceOnly = (s: string): boolean => {
  if (s.length === 0) return true;
  for (const ch of s) {
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
};

const escapeAsciidoc = (input: string): string => {
  // Only `|` is structurally hostile (closes a cell). Newlines and
  // every other character pass through; AsciiDoc treats embedded `\n`
  // as a soft line break within a cell.
  let out = '';
  for (const ch of input) {
    if (ch === '|') out += '\\|';
    else out += ch;
  }
  return out;
};

const renderCell = (
  cell: unknown,
  nullPrint: string,
  numericLocale: boolean,
): string => {
  if (cell === null || cell === undefined) return nullPrint;
  if (typeof cell === 'string') {
    return formatNumericLocale(cell, numericLocale);
  }
  if (typeof cell === 'number' || typeof cell === 'bigint') {
    return formatNumericLocale(cell.toString(), numericLocale);
  }
  if (typeof cell === 'boolean') return cell ? 't' : 'f';
  if (cell instanceof Date) return cell.toISOString();
  if (cell instanceof Uint8Array) {
    let hex = '\\x';
    for (const b of cell) hex += b.toString(16).padStart(2, '0');
    return hex;
  }
  return JSON.stringify(cell);
};
