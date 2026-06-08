import type { ResultSet } from '../types/connection.js';
import type { PrintQueryOpts, Printer } from '../types/printer.js';

import { formatNumericLocale } from './units.js';

/**
 * RFC 4180 CSV printer.
 *
 * Mirrors print.c `print_csv_text` / `print_csv_vertical`.
 *
 * - Field separator defaults to `,`; honors `topt.csvFieldSep`. The
 *   separator must be a single character and may not be `"`, `\n`, or
 *   `\r` (matches the psql `\pset csv_fieldsep` check).
 * - Line ending is always `\n` regardless of `topt.recordSep`, since
 *   `print_csv_text` writes `'\n'` literally.
 * - Header row is printed only when `startTable && !tuplesOnly`
 *   (matches `print_csv_text` — see the `start_table && !tuples_only`
 *   guard upstream). `\pset tuples_only true` suppresses the header.
 * - No footer in CSV.
 * - Expanded mode (`print_csv_vertical`) prints `name,value` lines and
 *   never emits a standalone header row.
 *
 * Quoting rule (from `csv_print_field`): wrap in double quotes if the
 * value contains the separator, a `"`, `\n`, or `\r`; inside quotes,
 * double the embedded `"`. We additionally quote `\.` (psql's COPY
 * sentinel) when the separator is `\` or `.`, matching upstream.
 */
export const csvPrinter: Printer = {
  format: 'csv',
  printQuery(
    rs: ResultSet,
    opts: PrintQueryOpts,
    out: NodeJS.WritableStream,
  ): Promise<void> {
    const topt = opts.topt;
    const sep =
      topt.csvFieldSep !== undefined && topt.csvFieldSep !== ''
        ? topt.csvFieldSep
        : ',';

    if (sep.length !== 1 || sep === '"' || sep === '\n' || sep === '\r') {
      throw new RangeError(
        `csv_fieldsep must be a single character other than '"', '\\n', or '\\r' (got ${JSON.stringify(sep)})`,
      );
    }

    const nullPrint = opts.nullPrint !== '' ? opts.nullPrint : topt.nullPrint;
    const expanded = topt.expanded === 'on';

    const headers = rs.fields.map((f) => f.name);
    const cells: string[][] = rs.rows.map((row) =>
      row.map((cell) => renderCell(cell, nullPrint, topt.numericLocale)),
    );

    let outBuf = '';

    if (expanded) {
      for (const row of cells) {
        row.forEach((value, colIdx) => {
          outBuf +=
            csvField(headers[colIdx], sep) + sep + csvField(value, sep) + '\n';
        });
      }
    } else {
      // Header is gated on startTable && !tuplesOnly (cf. print.c).
      if (topt.startTable && !topt.tuplesOnly) {
        outBuf += headers.map((h) => csvField(h, sep)).join(sep) + '\n';
      }
      for (const row of cells) {
        outBuf += row.map((c) => csvField(c, sep)).join(sep) + '\n';
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
    let hex = '\\x';
    for (const b of cell) hex += b.toString(16).padStart(2, '0');
    return hex;
  }
  return JSON.stringify(cell);
};

const csvField = (value: string, sep: string): string => {
  const needsQuote =
    value.includes(sep) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r') ||
    value === '\\.' ||
    sep === '\\' ||
    sep === '.';
  if (!needsQuote) return value;
  return `"${value.replace(/"/g, '""')}"`;
};
