import type { ResultSet } from '../types/connection.js';
import type { PrintQueryOpts, Printer } from '../types/printer.js';

/**
 * JSON printer (used by `\gset`, `\gdesc`, and `--json` callers later
 * in the WP plan).
 *
 * Output shape:
 *   [{ "col": value, ... }, ...]
 *
 * - Default emits a single-line array; `topt.expanded === 'on'`
 *   pretty-prints with two-space indentation.
 * - SQL NULL → JSON null.
 * - Numeric column data types (INT2/4/8, FLOAT4/8, NUMERIC) are
 *   parsed to JSON numbers when the string is a finite JS number.
 *   Anything outside `Number.isFinite` (large NUMERIC, NaN, Inf) is
 *   preserved as a string so we never silently lose precision.
 * - Booleans, dates, bytea, and unknown objects render as their
 *   natural JSON forms (boolean / ISO string / hex-prefixed string /
 *   stringified).
 *
 * Output is deterministic: column key order matches `rs.fields`; we
 * never reorder rows.
 */

// PostgreSQL type OIDs for the numeric family that map cleanly to
// JSON numbers. NUMERIC is included but guarded by isFinite().
const NUMERIC_TYPE_OIDS: ReadonlySet<number> = new Set([
  21, // INT2
  23, // INT4
  20, // INT8
  700, // FLOAT4
  701, // FLOAT8
  1700, // NUMERIC
]);

export const jsonPrinter: Printer = {
  format: 'json',
  printQuery(
    rs: ResultSet,
    opts: PrintQueryOpts,
    out: NodeJS.WritableStream,
  ): Promise<void> {
    const pretty = opts.topt.expanded === 'on';

    const objects: Record<string, unknown>[] = rs.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      rs.fields.forEach((field, idx) => {
        obj[field.name] = renderCell(row[idx], field.dataTypeID);
      });
      return obj;
    });

    const serialized = pretty
      ? JSON.stringify(objects, null, 2)
      : JSON.stringify(objects);

    out.write(serialized + '\n');
    return Promise.resolve();
  },
};

const renderCell = (cell: unknown, dataTypeID: number): unknown => {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'number') {
    return Number.isFinite(cell) ? cell : cell.toString();
  }
  if (typeof cell === 'bigint') {
    // Preserve as string when outside safe integer range.
    const asNum = Number(cell);
    return BigInt(asNum) === cell ? asNum : cell.toString();
  }
  if (typeof cell === 'boolean') return cell;
  if (cell instanceof Date) return cell.toISOString();
  if (cell instanceof Uint8Array) {
    let hex = '\\x';
    for (const b of cell) hex += b.toString(16).padStart(2, '0');
    return hex;
  }
  if (typeof cell === 'string') {
    if (NUMERIC_TYPE_OIDS.has(dataTypeID)) {
      const parsed = Number(cell);
      if (Number.isFinite(parsed) && String(parsed) === normalize(cell)) {
        return parsed;
      }
    }
    return cell;
  }
  return cell;
};

/**
 * Normalize a numeric string so the `String(parsed) === normalize(cell)`
 * round-trip is stable: strip a single leading `+`, drop trailing zeros
 * after a decimal point, drop a trailing bare decimal point, and drop a
 * leading zero before a multi-digit integer.
 */
const normalize = (s: string): string => {
  let v = s;
  if (v.startsWith('+')) v = v.slice(1);
  if (v.includes('.')) {
    v = v.replace(/0+$/, '').replace(/\.$/, '');
  }
  return v;
};
