import { describe, test, expect } from 'vitest';

import type { FieldDescription, ResultSet } from '../types/connection.js';
import type { PrintQueryOpts, PrintTableOpts } from '../types/printer.js';

import { latexPrinter, latexLongtablePrinter } from './latex.js';

const defaultTopt = (overrides?: Partial<PrintTableOpts>): PrintTableOpts => ({
  format: 'latex',
  expanded: 'off',
  border: 1,
  pager: 'off',
  pagerMinLines: 0,
  tuplesOnly: false,
  startTable: true,
  stopTable: true,
  defaultFooter: true,
  prior: 0,
  encoding: 'utf-8',
  envColumns: 80,
  columns: 80,
  unicodeBorderLineStyle: 'ascii',
  unicodeColumnLineStyle: 'ascii',
  unicodeHeaderLineStyle: 'ascii',
  fieldSep: '|',
  recordSep: '\n',
  numericLocale: false,
  tableAttr: null,
  title: null,
  footers: null,
  translateHeader: false,
  translateColumns: null,
  nullPrint: '',
  csvFieldSep: ',',
  ...overrides,
});

const defaultOpts = (
  overrides?: Partial<PrintQueryOpts>,
  toptOverrides?: Partial<PrintTableOpts>,
): PrintQueryOpts => ({
  topt: defaultTopt(toptOverrides),
  nullPrint: '',
  title: null,
  footers: null,
  translateHeader: false,
  translateColumns: null,
  nTranslateColumns: 0,
  ...overrides,
});

type ColumnSpec = { name: string; oid?: number };

const makeResultSet = ({
  columns,
  rows,
}: {
  columns: ColumnSpec[];
  rows: unknown[][];
}): ResultSet => {
  const fields: FieldDescription[] = columns.map((c, idx) => ({
    name: c.name,
    tableID: 0,
    columnID: idx + 1,
    dataTypeID: c.oid ?? 25,
    dataTypeSize: -1,
    dataTypeModifier: -1,
    format: 0,
  }));
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: null,
    fields,
    rows,
    notices: [],
  };
};

const capture = async (
  fn: (out: NodeJS.WritableStream) => Promise<void>,
): Promise<string> => {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  await fn(stream);
  return chunks.join('');
};

describe('latexPrinter', () => {
  test('renders a 3x3 table with one numeric column (border=1)', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'id', oid: 23 }, { name: 'name' }, { name: 'val' }],
      rows: [
        [1, 'alice', 'x'],
        [2, 'bob', 'y'],
        [3, 'carol', 'z'],
      ],
    });
    const out = await capture((s) =>
      latexPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe(
      '\\begin{tabular}{r | l | l}\n' +
        '\\textit{id} & \\textit{name} & \\textit{val} \\\\\n' +
        '\\hline\n' +
        '1 & alice & x \\\\\n' +
        '2 & bob & y \\\\\n' +
        '3 & carol & z \\\\\n' +
        '\\end{tabular}\n\n\\noindent ' +
        '(3 rows) \\\\\n' +
        '\n',
    );
  });

  test('border=0 omits column separators; border=2 wraps with |', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [['x', 'y']],
    });

    const b0 = await capture((s) =>
      latexPrinter.printQuery(
        rs,
        defaultOpts(undefined, { border: 0, defaultFooter: false }),
        s,
      ),
    );
    expect(b0).toContain('\\begin{tabular}{ll}\n');

    const b2 = await capture((s) =>
      latexPrinter.printQuery(
        rs,
        defaultOpts(undefined, { border: 2, defaultFooter: false }),
        s,
      ),
    );
    expect(b2).toContain('\\begin{tabular}{| l | l |}\n');
    // border==2 adds \hline before header and at end of table.
    expect(b2.indexOf('\\hline\n\\textit{a}')).toBeGreaterThan(-1);
    expect(b2).toContain('\\hline\n\\end{tabular}');
  });

  test('border=3 emits \\hline after every row', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }],
      rows: [['x'], ['y']],
    });
    const out = await capture((s) =>
      latexPrinter.printQuery(
        rs,
        defaultOpts(undefined, { border: 3, defaultFooter: false }),
        s,
      ),
    );
    expect(out).toContain('x \\\\\n\\hline\ny \\\\\n\\hline\n');
  });

  test('escapes all LaTeX-special characters', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'c' }],
      rows: [['# $ % & _ { } ~ ^ \\ | < >'], ['line1\nline2']],
    });
    const out = await capture((s) =>
      latexPrinter.printQuery(
        rs,
        defaultOpts(undefined, { defaultFooter: false }),
        s,
      ),
    );
    expect(out).toContain(
      '\\# \\$ \\% \\& \\_ \\{ \\} \\~{} \\^{} \\textbackslash{} \\textbar{} \\textless{} \\textgreater{}',
    );
    // Newline inside a cell becomes the LaTeX line break \\.
    expect(out).toContain('line1\\\\line2');
  });

  test('empty result emits header and (0 rows) footer', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'col' }],
      rows: [],
    });
    const out = await capture((s) =>
      latexPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe(
      '\\begin{tabular}{l}\n' +
        '\\textit{col} \\\\\n' +
        '\\hline\n' +
        '\\end{tabular}\n\n\\noindent ' +
        '(0 rows) \\\\\n' +
        '\n',
    );
  });

  test('tuplesOnly drops title, headers, and footers', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'col' }],
      rows: [['x']],
    });
    const out = await capture((s) =>
      latexPrinter.printQuery(
        rs,
        defaultOpts({ title: 'T' }, { tuplesOnly: true }),
        s,
      ),
    );
    expect(out).toBe(
      '\\begin{tabular}{l}\n' + 'x \\\\\n' + '\\end{tabular}\n\n\\noindent \n',
    );
  });

  test('renders title and user footers', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'col' }],
      rows: [['x']],
    });
    const out = await capture((s) =>
      latexPrinter.printQuery(
        rs,
        defaultOpts({
          title: 'My$Title',
          footers: ['note 1', 'note & 2'],
        }),
        s,
      ),
    );
    expect(
      out.startsWith(
        '\\begin{center}\nMy\\$Title\n\\end{center}\n\n\\begin{tabular}{',
      ),
    ).toBe(true);
    expect(out).toContain('note 1 \\\\\nnote \\& 2 \\\\\n');
  });
});

describe('latexLongtablePrinter', () => {
  test('renders longtable preamble with firsthead and endhead', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'id', oid: 23 }, { name: 'name' }],
      rows: [
        [1, 'alice'],
        [2, 'bob'],
      ],
    });
    const out = await capture((s) =>
      latexLongtablePrinter.printQuery(
        rs,
        defaultOpts(undefined, { defaultFooter: false }),
        s,
      ),
    );
    expect(out).toBe(
      '\\begin{longtable}{r | l}\n' +
        '\\small\\textbf{\\textit{id}} & \\small\\textbf{\\textit{name}} \\\\\n' +
        '\\midrule\n\\endfirsthead\n' +
        '\\small\\textbf{\\textit{id}} & \\small\\textbf{\\textit{name}} \\\\\n' +
        '\\midrule\n\\endhead\n' +
        '\\raggedright{1}\n&\n\\raggedright{alice} \\tabularnewline\n' +
        '\\raggedright{2}\n&\n\\raggedright{bob} \\tabularnewline\n' +
        '\\end{longtable}\n',
    );
  });

  test('renders \\caption blocks when a title is set', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }],
      rows: [['x']],
    });
    const out = await capture((s) =>
      latexLongtablePrinter.printQuery(
        rs,
        defaultOpts({ title: 'My$Title' }, { defaultFooter: false }),
        s,
      ),
    );
    expect(out).toContain(
      '\\caption[My\\$Title (Continued)]{My\\$Title}\n\\endfoot\n',
    );
    expect(out).toContain('\\caption[My\\$Title]{My\\$Title}\n\\endlastfoot\n');
  });

  test('border=2 wraps the column spec and adds toprule/bottomrule', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }],
      rows: [['x']],
    });
    const out = await capture((s) =>
      latexLongtablePrinter.printQuery(
        rs,
        defaultOpts(undefined, { border: 2, defaultFooter: false }),
        s,
      ),
    );
    expect(out).toContain('\\begin{longtable}{| l |}\n');
    expect(out).toContain('\\toprule\n');
    expect(out).toContain('\\bottomrule\n\\endfoot\n');
    expect(out).toContain('\\bottomrule\n\\endlastfoot\n');
  });

  test('tuplesOnly drops headers entirely', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }],
      rows: [['x']],
    });
    const out = await capture((s) =>
      latexLongtablePrinter.printQuery(
        rs,
        defaultOpts(undefined, { tuplesOnly: true }),
        s,
      ),
    );
    expect(out).toBe(
      '\\begin{longtable}{l}\n' +
        '\\raggedright{x} \\tabularnewline\n' +
        '\\end{longtable}\n',
    );
  });

  test('empty result still emits the longtable scaffold', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }],
      rows: [],
    });
    const out = await capture((s) =>
      latexLongtablePrinter.printQuery(
        rs,
        defaultOpts(undefined, { defaultFooter: false }),
        s,
      ),
    );
    expect(out).toBe(
      '\\begin{longtable}{l}\n' +
        '\\small\\textbf{\\textit{a}} \\\\\n' +
        '\\midrule\n\\endfirsthead\n' +
        '\\small\\textbf{\\textit{a}} \\\\\n' +
        '\\midrule\n\\endhead\n' +
        '\\end{longtable}\n',
    );
  });
});
