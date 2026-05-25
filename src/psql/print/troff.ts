import type { ResultSet } from '../types/connection.js';
import type { PrintQueryOpts, Printer } from '../types/printer.js';

import { formatNumericLocale } from './units.js';

/**
 * Troff MS printer.
 *
 * Mirrors print.c `print_troff_ms_text`.
 *
 * Output shape (with title and one footer):
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
 * - `topt.border` is clamped to 0..2. `border == 2` uses `center box;`;
 *   otherwise just `center;`. Border > 0 inserts ` | ` between column
 *   spec letters.
 * - Numeric columns get `r`, others `l` (per the OID heuristic).
 * - Tab is the field separator (consistent with `.TS` defaults).
 * - The only structurally-hostile character is `\\`, which becomes
 *   `\(rs` (troff's "reverse solidus" glyph). Everything else passes
 *   through verbatim — troff ms is a byte stream.
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
  },
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
