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
      // Vertical mode mirrors print.c `print_unaligned_vertical`: each
      // record gap is a DOUBLE recordSep, the title (if any) emits
      // without a trailing separator (the loop handles that), inter-
      // column lines get one recordSep, and the closing footer block is
      // preceded by a recordSep with one more recordSep separating each
      // footer entry.
      let needRecordSep = false;
      if (!tuplesOnly && opts.title) {
        outBuf += opts.title;
        needRecordSep = true;
      }
      cells.forEach((row) => {
        if (needRecordSep) {
          outBuf += recordSep + recordSep;
          needRecordSep = false;
        }
        row.forEach((value, colIdx) => {
          outBuf += headers[colIdx] + fieldSep + value;
          if (colIdx < row.length - 1) {
            outBuf += recordSep;
          } else {
            needRecordSep = true;
          }
        });
      });

      if (!tuplesOnly && opts.footers && opts.footers.length > 0) {
        outBuf += recordSep;
        for (const footer of opts.footers) {
          outBuf += recordSep + footer;
        }
        needRecordSep = true;
      }

      if (needRecordSep) outBuf += recordSep;
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

      // Default `(N rows)` footer is suppressed when the caller supplied its
      // own footers — upstream (and aligned.ts) print user footers INSTEAD of
      // the row count, not in addition (review: unaligned footer duplication).
      const hasUserFooters =
        opts.footers !== undefined &&
        opts.footers !== null &&
        opts.footers.length > 0;
      if (!tuplesOnly && topt.defaultFooter && !hasUserFooters) {
        const n = rs.rows.length;
        outBuf += `(${String(n)} ${n === 1 ? 'row' : 'rows'})` + recordSep;
      }

      if (!tuplesOnly && hasUserFooters) {
        for (const footer of opts.footers ?? []) {
          outBuf += footer + recordSep;
        }
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
