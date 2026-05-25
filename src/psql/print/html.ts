import type { ResultSet } from '../types/connection.js';
import type { PrintQueryOpts, Printer } from '../types/printer.js';

import { formatNumericLocale } from './units.js';

/**
 * HTML printer.
 *
 * Mirrors print.c `print_html_text`.
 *
 * Output shape (with title + footers):
 *   <table border="1">
 *     <caption>title</caption>
 *     <tr>
 *       <th align="center">col</th>
 *       ...
 *     </tr>
 *     <tr valign="top">
 *       <td align="left">val</td>
 *       ...
 *     </tr>
 *     ...
 *   </table>
 *   <p>(N rows)<br />
 *   footer<br />
 *   </p>
 *
 * - `topt.tableAttr` is appended to the opening `<table>` tag.
 * - `topt.border` becomes the `border="..."` value.
 * - `topt.startTable` / `stopTable` gate the prologue/epilogue, allowing
 *   chunked streaming. For this WP both default to true, so the full
 *   document is emitted in one call.
 * - Right-align numeric columns based on the PG type-OID heuristic
 *   (`NUMERIC_OIDS`), matching how `print_aligned_text` derives the
 *   `aligns` array upstream.
 * - Cells that are whitespace-only render `&nbsp; ` so the cell still
 *   takes layout space (verbatim upstream behavior).
 */

// INT2, INT4, INT8, FLOAT4, FLOAT8, NUMERIC, INTERVAL.
const NUMERIC_OIDS = new Set<number>([21, 23, 20, 700, 701, 1700, 1186]);

export const htmlPrinter: Printer = {
  format: 'html',
  printQuery(
    rs: ResultSet,
    opts: PrintQueryOpts,
    out: NodeJS.WritableStream,
  ): Promise<void> {
    const topt = opts.topt;
    const tuplesOnly = topt.tuplesOnly;
    const startTable = topt.startTable;
    const stopTable = topt.stopTable;
    const nullPrint = opts.nullPrint !== '' ? opts.nullPrint : topt.nullPrint;
    const title = opts.title ?? topt.title;
    const footers = opts.footers ?? topt.footers;

    const headers = rs.fields.map((f) => f.name);
    const aligns = rs.fields.map((f) =>
      NUMERIC_OIDS.has(f.dataTypeID) ? 'right' : 'left',
    );
    const cells: string[][] = rs.rows.map((row) =>
      row.map((cell) => renderCell(cell, nullPrint, topt.numericLocale)),
    );

    let buf = '';

    if (startTable) {
      buf += `<table border="${String(topt.border)}"`;
      if (topt.tableAttr) buf += ` ${topt.tableAttr}`;
      buf += '>\n';

      if (!tuplesOnly && title) {
        buf += '  <caption>' + escapeHtml(title) + '</caption>\n';
      }

      if (!tuplesOnly) {
        buf += '  <tr>\n';
        for (const h of headers) {
          buf += '    <th align="center">' + escapeHtml(h) + '</th>\n';
        }
        buf += '  </tr>\n';
      }
    }

    for (const row of cells) {
      buf += '  <tr valign="top">\n';
      row.forEach((value, idx) => {
        buf += `    <td align="${aligns[idx]}">`;
        if (isWhitespaceOnly(value)) {
          buf += '&nbsp; ';
        } else {
          buf += escapeHtml(value);
        }
        buf += '</td>\n';
      });
      buf += '  </tr>\n';
    }

    if (stopTable) {
      buf += '</table>\n';

      if (!tuplesOnly) {
        const effective = effectiveFooters(rs, topt, footers);
        if (effective.length > 0) {
          buf += '<p>';
          for (const f of effective) {
            buf += escapeHtml(f) + '<br />\n';
          }
          buf += '</p>';
          buf += '\n';
        }
      }
    }

    out.write(buf);
    return Promise.resolve();
  },
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

const escapeHtml = (input: string): string => {
  // Upstream `html_escaped_print` walks the string byte-by-byte and
  // converts leading spaces (per line) to `&nbsp;` so EXPLAIN output
  // stays indented. We replicate that with a stateful pass.
  let out = '';
  let leadingSpace = true;
  for (const ch of input) {
    switch (ch) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += '&quot;';
        break;
      case '\n':
        out += '<br />\n';
        break;
      case ' ':
        out += leadingSpace ? '&nbsp;' : ' ';
        break;
      default:
        out += ch;
    }
    if (ch !== ' ') leadingSpace = false;
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
