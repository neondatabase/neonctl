import type { ResultSet } from '../types/connection.js';
import type { PrintQueryOpts, Printer } from '../types/printer.js';

import { formatNumericLocale } from './units.js';

/**
 * Troff MS printer.
 *
 * Mirrors print.c `print_troff_ms_text` and `print_troff_ms_vertical`.
 *
 * Output shape (flat, with title and one footer):
 *   .LP
 *   .DS C
 *   title
 *   .DE
 *   .LP
 *   .TS
 *   center;
 *   l | l | r.
 *   \fIcol1\fP	\fIcol2\fP	\fIcol3\fP
 *   _
 *   val1	val2	val3
 *   .TE
 *   .DS L
 *   (N rows)
 *   .DE
 *
 * Output shape (expanded, `\pset expanded on`):
 *   .LP
 *   .TS
 *   center;
 *   c s.
 *   \fIRecord 1\fP
 *   _              # if border>=1
 *   .T&
 *   c | l.         # `c l.` when border != 1
 *   colname1	val1
 *   colname2	val2
 *   ...
 *   .T&
 *   c s.
 *   \fIRecord 2\fP
 *   ...
 *   .TE
 *   .DS L
 *   .DE
 *
 * - `topt.border` is clamped to 0..2. `border == 2` uses `center box;`;
 *   otherwise just `center;`. Border > 0 inserts ` | ` between column
 *   spec letters.
 * - Numeric columns get `r`, others `l` (per the OID heuristic).
 * - Tab is the field separator (consistent with `.TS` defaults).
 * - The only structurally-hostile character is `\\`, which becomes
 *   `\(rs` (troff's "reverse solidus" glyph). Everything else passes
 *   through verbatim — troff ms is a byte stream.
 * - Expanded mode emits a `.T&\n<spec>.\n` re-spec block between the
 *   "Record N" header (`c s.`) and the body (`c l.` / `c | l.`); under
 *   tuples-only the body spec is set once as `c l;` after the table
 *   header. No default `(N rows)` footer.
 */

// INT2, INT4, INT8, FLOAT4, FLOAT8, NUMERIC, INTERVAL.
const NUMERIC_OIDS = new Set<number>([21, 23, 20, 700, 701, 1700, 1186]);

export const troffMsPrinter: Printer = {
  format: 'troff-ms',
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
  const border = clampBorder(topt.border);
  const nullPrint = opts.nullPrint !== '' ? opts.nullPrint : topt.nullPrint;
  const title = opts.title ?? topt.title;
  const footers = opts.footers ?? topt.footers;

  const headers = rs.fields.map((f) => f.name);
  const ncols = rs.fields.length;
  const aligns: ('l' | 'r')[] = rs.fields.map((f) =>
    NUMERIC_OIDS.has(f.dataTypeID) ? 'r' : 'l',
  );
  const cells: string[][] = rs.rows.map((row) =>
    row.map((cell) => renderCell(cell, nullPrint, topt.numericLocale)),
  );

  let buf = '';

  if (startTable) {
    if (!tuplesOnly && title) {
      buf += '.LP\n.DS C\n';
      buf += escapeTroff(title);
      buf += '\n.DE\n';
    }

    buf += '.LP\n.TS\n';
    buf += border === 2 ? 'center box;\n' : 'center;\n';

    aligns.forEach((a, idx) => {
      buf += a;
      if (border > 0 && idx < ncols - 1) buf += ' | ';
    });
    buf += '.\n';

    if (!tuplesOnly) {
      headers.forEach((h, idx) => {
        if (idx !== 0) buf += '\t';
        buf += '\\fI' + escapeTroff(h) + '\\fP';
      });
      buf += '\n_\n';
    }
  }

  cells.forEach((row) => {
    row.forEach((value, idx) => {
      buf += escapeTroff(value);
      if (idx === ncols - 1) buf += '\n';
      else buf += '\t';
    });
  });

  if (stopTable) {
    buf += '.TE\n.DS L\n';
    if (!tuplesOnly) {
      const effective = effectiveFooters(rs, topt, footers);
      for (const f of effective) {
        buf += escapeTroff(f) + '\n';
      }
    }
    buf += '.DE\n';
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
  const border = clampBorder(topt.border);
  const nullPrint = opts.nullPrint !== '' ? opts.nullPrint : topt.nullPrint;
  const title = opts.title ?? topt.title;
  const footers = opts.footers ?? topt.footers;

  const headers = rs.fields.map((f) => f.name);
  const cells: string[][] = rs.rows.map((row) =>
    row.map((cell) => renderCell(cell, nullPrint, topt.numericLocale)),
  );

  let buf = '';
  // currentFormat: 0 = none yet, 1 = "Record N" header (c s),
  // 2 = body (c l or c | l). Upstream uses the same tri-state to
  // decide when to emit `.T&` separators.
  let currentFormat = 0;

  if (startTable) {
    if (!tuplesOnly && title) {
      buf += '.LP\n.DS C\n';
      buf += escapeTroff(title);
      buf += '\n.DE\n';
    }

    buf += '.LP\n.TS\n';
    buf += border === 2 ? 'center box;\n' : 'center;\n';

    // Under tuples-only, upstream emits a one-shot `c l;` body spec
    // here so each Record's first .T& block is omitted.
    if (tuplesOnly) {
      buf += 'c l;\n';
    }
  } else {
    // Continuation: assume body spec is already in effect.
    currentFormat = 2;
  }

  let record = topt.prior + 1;
  cells.forEach((row, rowIdx) => {
    if (!tuplesOnly) {
      if (currentFormat !== 1) {
        if (border === 2 && rowIdx > 0) buf += '_\n';
        if (currentFormat !== 0) buf += '.T&\n';
        buf += 'c s.\n';
        currentFormat = 1;
      }
      buf += `\\fIRecord ${String(record)}\\fP\n`;
      record += 1;
    }
    if (border >= 1) buf += '_\n';

    if (!tuplesOnly) {
      if (currentFormat !== 2) {
        if (currentFormat !== 0) buf += '.T&\n';
        buf += border !== 1 ? 'c l.\n' : 'c | l.\n';
        currentFormat = 2;
      }
    }

    row.forEach((value, idx) => {
      buf += escapeTroff(headers[idx]);
      buf += '\t';
      buf += escapeTroff(value);
      buf += '\n';
    });
  });

  if (stopTable) {
    buf += '.TE\n.DS L\n';
    // Expanded mode does NOT emit the default "(N rows)" footer.
    if (!tuplesOnly && footers && footers.length > 0) {
      for (const f of footers) {
        buf += escapeTroff(f) + '\n';
      }
    }
    buf += '.DE\n';
  }

  out.write(buf);
  return Promise.resolve();
};

const clampBorder = (b: number): number => {
  if (b > 2) return 2;
  if (b < 0) return 0;
  return b;
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

const escapeTroff = (input: string): string => {
  // Only `\` is dangerous (it begins a troff escape). Map it to `\(rs`,
  // which renders the reverse-solidus glyph. Newlines flow through
  // unchanged — `.TS` treats each line as a new row, so we never want
  // raw newlines inside a cell; that constraint is enforced upstream
  // by the caller, not here. (`renderCell` similarly never emits a raw
  // newline today.)
  let out = '';
  for (const ch of input) {
    if (ch === '\\') out += '\\(rs';
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
