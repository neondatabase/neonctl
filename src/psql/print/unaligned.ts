import type { ResultSet } from '../types/connection.js';
import type { PrintQueryOpts, Printer } from '../types/printer.js';

import { formatNumericLocale } from './units.js';

/**
 * Unaligned tabular printer.
 *
 * Mirrors print.c `print_unaligned_text` / `print_unaligned_vertical`.
 *
 * Field separator defaults to `|`, record separator defaults to `\n`,
 * both honor `opts.topt.fieldSep` / `recordSep`. NULL cells render
 * `opts.nullPrint` (which falls back to `topt.nullPrint`, default `''`).
 *
 * Expanded (`\x`) mode prints `colname|value` per line with a blank
 * record-sep gap between rows.
 *
 * The default footer `(N rows)` is only emitted when not in expanded
 * mode and `topt.defaultFooter` is true; same as upstream psql.
 */
export const unalignedPrinter: Printer = {
  format: 'unaligned',
  printQuery(
    rs: ResultSet,
    opts: PrintQueryOpts,
    out: NodeJS.WritableStream,
  ): Promise<void> {
    const topt = opts.topt;
    const fieldSep = topt.fieldSep !== '' ? topt.fieldSep : '|';
    const recordSep = topt.recordSep !== '' ? topt.recordSep : '\n';
    const nullPrint = opts.nullPrint !== '' ? opts.nullPrint : topt.nullPrint;
    const expanded = topt.expanded === 'on';
    const tuplesOnly = topt.tuplesOnly;

    const headers = rs.fields.map((f) => f.name);
    const cells: string[][] = rs.rows.map((row) =>
      row.map((cell) => renderCell(cell, nullPrint, topt.numericLocale)),
    );

    let outBuf = '';

    if (expanded) {
      // Vertical mode: each record is N `header|value` lines, with a
      // blank record-sep between records and an initial separator after
      // the title if present.
      if (!tuplesOnly && opts.title) {
        outBuf += opts.title + recordSep;
      }

      cells.forEach((row, rowIdx) => {
        if (rowIdx > 0) outBuf += recordSep;
        row.forEach((value, colIdx) => {
          outBuf += headers[colIdx] + fieldSep + value + recordSep;
        });
      });
    } else {
      // Horizontal mode.
      if (!tuplesOnly && opts.title) {
        outBuf += opts.title + recordSep;
      }

      if (!tuplesOnly) {
        outBuf += headers.join(fieldSep) + recordSep;
      }

      cells.forEach((row) => {
        outBuf += row.join(fieldSep) + recordSep;
      });

      if (!tuplesOnly && topt.defaultFooter) {
        const n = rs.rows.length;
        outBuf += `(${String(n)} ${n === 1 ? 'row' : 'rows'})` + recordSep;
      }
    }

    if (!tuplesOnly && opts.footers) {
      for (const footer of opts.footers) {
        outBuf += footer + recordSep;
      }
    }

    out.write(outBuf);
    return Promise.resolve();
  },
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
    // Bytea -> hex escape, matching libpq's `\x` form.
    let hex = '\\x';
    for (const b of cell) hex += b.toString(16).padStart(2, '0');
    return hex;
  }
  return JSON.stringify(cell);
};
