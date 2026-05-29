import type { ResultSet } from '../types/connection.js';
import type { PrintQueryOpts, Printer } from '../types/printer.js';

import { formatNumericLocale } from './units.js';

/**
 * LaTeX printers — `latex` (tabular) and `latex-longtable` (longtable).
 *
 * Mirrors print.c `print_latex_text`, `print_latex_vertical`, and
 * `print_latex_longtable_text`. Expanded mode for both `latex` and
 * `latex-longtable` falls through to the vertical renderer
 * (`print_latex_vertical`) — that's how upstream dispatches.
 *
 * Border behavior (flat tabular, from print.c):
 *   - `topt.border` is clamped to 0..3.
 *   - tabular column spec gets ` | ` between columns when border > 0,
 *     and a leading/trailing `|` at border >= 2.
 *   - border == 2 emits `\hline` around header and at end of table.
 *   - border == 3 emits `\hline` after every row.
 *
 * Border behavior (expanded, from print.c):
 *   - `topt.border` is clamped to 0..2 (note: not 0..3).
 *   - tabular column spec is `cl`, `c|l`, or `|c|l|` for border 0/1/2.
 *   - border >= 1 emits `\hline` between records.
 *   - border == 2 wraps each "Record N" header in `\hline` lines.
 *
 * Numeric columns (per the OID heuristic) get the `r` alignment letter;
 * everything else gets `l`. That letter is passed straight through to
 * LaTeX's column spec.
 *
 * Escape: 14 LaTeX-special characters are rewritten. Embedded newlines
 * in a cell turn into `\\` (LaTeX line break) for `latex`. The
 * longtable variant uses the same escape but wraps cells in
 * `\raggedright{...}` and ends rows with `\tabularnewline`.
 */

// INT2, INT4, INT8, FLOAT4, FLOAT8, NUMERIC, INTERVAL.
const NUMERIC_OIDS = new Set<number>([21, 23, 20, 700, 701, 1700, 1186]);

export const latexPrinter: Printer = {
  format: 'latex',
  printQuery(
    rs: ResultSet,
    opts: PrintQueryOpts,
    out: NodeJS.WritableStream,
  ): Promise<void> {
    const topt = opts.topt;
    if (topt.expanded === 'on') {
      return printLatexVertical(rs, opts, out);
    }
    return printLatexFlat(rs, opts, out);
  },
};

const printLatexFlat = (
  rs: ResultSet,
  opts: PrintQueryOpts,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const topt = opts.topt;
  const tuplesOnly = topt.tuplesOnly;
  const startTable = topt.startTable;
  const stopTable = topt.stopTable;
  const border = clampBorder(topt.border, 3);
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
      buf += '\\begin{center}\n';
      buf += escapeLatex(title);
      buf += '\n\\end{center}\n\n';
    }

    buf += '\\begin{tabular}{';
    if (border >= 2) buf += '| ';
    aligns.forEach((a, idx) => {
      buf += a;
      if (border !== 0 && idx < ncols - 1) buf += ' | ';
    });
    if (border >= 2) buf += ' |';
    buf += '}\n';

    if (!tuplesOnly && border >= 2) buf += '\\hline\n';

    if (!tuplesOnly) {
      headers.forEach((h, idx) => {
        if (idx !== 0) buf += ' & ';
        buf += '\\textit{' + escapeLatex(h) + '}';
      });
      buf += ' \\\\\n';
      buf += '\\hline\n';
    }
  }

  cells.forEach((row) => {
    row.forEach((value, idx) => {
      buf += escapeLatex(value);
      if (idx === ncols - 1) {
        buf += ' \\\\\n';
        if (border === 3) buf += '\\hline\n';
      } else {
        buf += ' & ';
      }
    });
  });

  if (stopTable) {
    if (border === 2) buf += '\\hline\n';
    buf += '\\end{tabular}\n\n\\noindent ';

    if (!tuplesOnly) {
      const effective = effectiveFooters(rs, topt, footers);
      for (const f of effective) {
        buf += escapeLatex(f) + ' \\\\\n';
      }
    }
    buf += '\n';
  }

  out.write(buf);
  return Promise.resolve();
};

const printLatexVertical = (
  rs: ResultSet,
  opts: PrintQueryOpts,
  out: NodeJS.WritableStream,
): Promise<void> => {
  const topt = opts.topt;
  const tuplesOnly = topt.tuplesOnly;
  const startTable = topt.startTable;
  const stopTable = topt.stopTable;
  const border = clampBorder(topt.border, 2);
  const nullPrint = opts.nullPrint !== '' ? opts.nullPrint : topt.nullPrint;
  const title = opts.title ?? topt.title;
  const footers = opts.footers ?? topt.footers;

  const headers = rs.fields.map((f) => f.name);
  const cells: string[][] = rs.rows.map((row) =>
    row.map((cell) => renderCell(cell, nullPrint, topt.numericLocale)),
  );

  let buf = '';

  if (startTable) {
    if (!tuplesOnly && title) {
      buf += '\\begin{center}\n';
      buf += escapeLatex(title);
      buf += '\n\\end{center}\n\n';
    }

    buf += '\\begin{tabular}{';
    if (border === 0) buf += 'cl';
    else if (border === 1) buf += 'c|l';
    else buf += '|c|l|';
    buf += '}\n';
  }

  let record = topt.prior + 1;
  cells.forEach((row) => {
    if (!tuplesOnly) {
      if (border === 2) {
        buf += '\\hline\n';
        buf += `\\multicolumn{2}{|c|}{\\textit{Record ${String(record)}}} \\\\\n`;
      } else {
        buf += `\\multicolumn{2}{c}{\\textit{Record ${String(record)}}} \\\\\n`;
      }
      record += 1;
    }
    if (border >= 1) buf += '\\hline\n';

    row.forEach((value, idx) => {
      buf += escapeLatex(headers[idx]);
      buf += ' & ';
      buf += escapeLatex(value);
      buf += ' \\\\\n';
    });
  });

  if (stopTable) {
    if (border === 2) buf += '\\hline\n';
    buf += '\\end{tabular}\n\n\\noindent ';

    // Expanded mode does NOT include the default "(N rows)" footer;
    // only user-supplied footers (matches print_latex_vertical).
    if (!tuplesOnly && footers && footers.length > 0) {
      for (const f of footers) {
        buf += escapeLatex(f) + ' \\\\\n';
      }
    }
    buf += '\n';
  }

  out.write(buf);
  return Promise.resolve();
};

export const latexLongtablePrinter: Printer = {
  format: 'latex-longtable',
  printQuery(
    rs: ResultSet,
    opts: PrintQueryOpts,
    out: NodeJS.WritableStream,
  ): Promise<void> {
    // Upstream dispatch sends both `latex` and `latex-longtable` to
    // `print_latex_vertical` when expanded is on (cf. print.c).
    if (opts.topt.expanded === 'on') {
      return printLatexVertical(rs, opts, out);
    }
    const topt = opts.topt;
    const tuplesOnly = topt.tuplesOnly;
    const startTable = topt.startTable;
    const stopTable = topt.stopTable;
    const border = clampBorder(topt.border, 3);
    const nullPrint = opts.nullPrint !== '' ? opts.nullPrint : topt.nullPrint;
    const title = opts.title ?? topt.title;

    const headers = rs.fields.map((f) => f.name);
    const ncols = rs.fields.length;
    const aligns: ('l' | 'r')[] = rs.fields.map((f) =>
      NUMERIC_OIDS.has(f.dataTypeID) ? 'r' : 'l',
    );
    const cells: string[][] = rs.rows.map((row) =>
      row.map((cell) => renderCell(cell, nullPrint, topt.numericLocale)),
    );

    // `topt.tableAttr` for longtable encodes per-column widths in a
    // whitespace-separated list, consumed left-to-right with a fall
    // back to the previous value once exhausted.
    const widths = (topt.tableAttr ?? '')
      .split(/[\s]+/)
      .filter((w) => w !== '');
    let widthCursor = 0;
    let lastWidth: string | null = null;

    let buf = '';

    if (startTable) {
      buf += '\\begin{longtable}{';
      if (border >= 2) buf += '| ';

      aligns.forEach((a, idx) => {
        if (a === 'l' && widths.length > 0) {
          let w: string | null = null;
          if (widthCursor < widths.length) {
            w = widths[widthCursor];
            widthCursor += 1;
            lastWidth = w;
          } else if (lastWidth !== null) {
            w = lastWidth;
          }
          if (w !== null) {
            buf += `p{${w}\\textwidth}`;
          } else {
            buf += 'l';
          }
        } else {
          buf += a;
        }
        if (border !== 0 && idx < ncols - 1) buf += ' | ';
      });

      if (border >= 2) buf += ' |';
      buf += '}\n';

      if (!tuplesOnly) {
        // firsthead
        if (border >= 2) buf += '\\toprule\n';
        headers.forEach((h, idx) => {
          if (idx !== 0) buf += ' & ';
          buf += '\\small\\textbf{\\textit{' + escapeLatex(h) + '}}';
        });
        buf += ' \\\\\n';
        buf += '\\midrule\n\\endfirsthead\n';

        // continuation heads
        if (border >= 2) buf += '\\toprule\n';
        headers.forEach((h, idx) => {
          if (idx !== 0) buf += ' & ';
          buf += '\\small\\textbf{\\textit{' + escapeLatex(h) + '}}';
        });
        buf += ' \\\\\n';
        if (border !== 3) buf += '\\midrule\n';
        buf += '\\endhead\n';

        if (title) {
          if (border === 2) buf += '\\bottomrule\n';
          buf +=
            '\\caption[' +
            escapeLatex(title) +
            ' (Continued)]{' +
            escapeLatex(title) +
            '}\n\\endfoot\n';
          if (border === 2) buf += '\\bottomrule\n';
          buf +=
            '\\caption[' +
            escapeLatex(title) +
            ']{' +
            escapeLatex(title) +
            '}\n\\endlastfoot\n';
        } else if (border >= 2) {
          buf += '\\bottomrule\n\\endfoot\n';
          buf += '\\bottomrule\n\\endlastfoot\n';
        }
      }
    }

    // Cells. Upstream interleaves `\n&\n` between in-row cells (and
    // emits `\tabularnewline` to end a row), wrapping each value in
    // `\raggedright{...}`.
    let cellIdx = 0;
    cells.forEach((row) => {
      row.forEach((value) => {
        if (cellIdx !== 0 && cellIdx % ncols !== 0) buf += '\n&\n';
        buf += '\\raggedright{' + escapeLatex(value) + '}';
        if ((cellIdx + 1) % ncols === 0) {
          buf += ' \\tabularnewline\n';
          if (border === 3) buf += ' \\hline\n';
        }
        cellIdx += 1;
      });
    });

    if (stopTable) buf += '\\end{longtable}\n';

    out.write(buf);
    return Promise.resolve();
  },
};

const clampBorder = (b: number, max: 2 | 3): number => {
  if (b > max) return max;
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

const escapeLatex = (input: string): string => {
  let out = '';
  for (const ch of input) {
    switch (ch) {
      case '#':
        out += '\\#';
        break;
      case '$':
        out += '\\$';
        break;
      case '%':
        out += '\\%';
        break;
      case '&':
        out += '\\&';
        break;
      case '<':
        out += '\\textless{}';
        break;
      case '>':
        out += '\\textgreater{}';
        break;
      case '\\':
        out += '\\textbackslash{}';
        break;
      case '^':
        out += '\\^{}';
        break;
      case '_':
        out += '\\_';
        break;
      case '{':
        out += '\\{';
        break;
      case '|':
        out += '\\textbar{}';
        break;
      case '}':
        out += '\\}';
        break;
      case '~':
        out += '\\~{}';
        break;
      case '\n':
        out += '\\\\';
        break;
      default:
        out += ch;
    }
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
