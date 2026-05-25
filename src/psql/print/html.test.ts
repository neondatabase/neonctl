import { describe, test, expect } from 'vitest';

import type { FieldDescription, ResultSet } from '../types/connection.js';
import type { PrintQueryOpts, PrintTableOpts } from '../types/printer.js';

import { htmlPrinter } from './html.js';

const defaultTopt = (overrides?: Partial<PrintTableOpts>): PrintTableOpts => ({
  format: 'html',
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

describe('htmlPrinter', () => {
  test('renders a 3x3 table with one numeric column right-aligned', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'id', oid: 23 }, { name: 'name' }, { name: 'val' }],
      rows: [
        [1, 'alice', 'x'],
        [2, 'bob', 'y'],
        [3, 'carol', 'z'],
      ],
    });
    const out = await capture((s) =>
      htmlPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe(
      '<table border="1">\n' +
        '  <tr>\n' +
        '    <th align="center">id</th>\n' +
        '    <th align="center">name</th>\n' +
        '    <th align="center">val</th>\n' +
        '  </tr>\n' +
        '  <tr valign="top">\n' +
        '    <td align="right">1</td>\n' +
        '    <td align="left">alice</td>\n' +
        '    <td align="left">x</td>\n' +
        '  </tr>\n' +
        '  <tr valign="top">\n' +
        '    <td align="right">2</td>\n' +
        '    <td align="left">bob</td>\n' +
        '    <td align="left">y</td>\n' +
        '  </tr>\n' +
        '  <tr valign="top">\n' +
        '    <td align="right">3</td>\n' +
        '    <td align="left">carol</td>\n' +
        '    <td align="left">z</td>\n' +
        '  </tr>\n' +
        '</table>\n' +
        '<p>(3 rows)<br />\n' +
        '</p>\n',
    );
  });

  test('escapes &, <, >, ", and newlines; protects leading spaces', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }],
      rows: [['a&b<c>d"e'], ['line1\nline2'], ['  indent'], ['mid space']],
    });
    const out = await capture((s) =>
      htmlPrinter.printQuery(
        rs,
        defaultOpts(undefined, { defaultFooter: false }),
        s,
      ),
    );
    expect(out).toContain('<td align="left">a&amp;b&lt;c&gt;d&quot;e</td>');
    expect(out).toContain('<td align="left">line1<br />\nline2</td>');
    expect(out).toContain('<td align="left">&nbsp;&nbsp;indent</td>');
    expect(out).toContain('<td align="left">mid space</td>');
  });

  test('renders whitespace-only cells as &nbsp;', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [['', 'x']],
    });
    const out = await capture((s) =>
      htmlPrinter.printQuery(
        rs,
        defaultOpts(undefined, { defaultFooter: false }),
        s,
      ),
    );
    expect(out).toContain('<td align="left">&nbsp; </td>');
  });

  test('honors tableAttr', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }],
      rows: [['x']],
    });
    const out = await capture((s) =>
      htmlPrinter.printQuery(
        rs,
        defaultOpts(undefined, {
          tableAttr: 'class="t"',
          defaultFooter: false,
        }),
        s,
      ),
    );
    expect(out.startsWith('<table border="1" class="t">\n')).toBe(true);
  });

  test('empty result renders header and (0 rows) footer', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'col' }],
      rows: [],
    });
    const out = await capture((s) =>
      htmlPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe(
      '<table border="1">\n' +
        '  <tr>\n' +
        '    <th align="center">col</th>\n' +
        '  </tr>\n' +
        '</table>\n' +
        '<p>(0 rows)<br />\n' +
        '</p>\n',
    );
  });

  test('one row uses singular "row" in the default footer', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'col' }],
      rows: [['x']],
    });
    const out = await capture((s) =>
      htmlPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toContain('<p>(1 row)<br />\n');
  });

  test('tuplesOnly suppresses caption, header, and footer', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'col' }],
      rows: [['x']],
    });
    const out = await capture((s) =>
      htmlPrinter.printQuery(
        rs,
        defaultOpts({ title: 'T' }, { tuplesOnly: true }),
        s,
      ),
    );
    expect(out).toBe(
      '<table border="1">\n' +
        '  <tr valign="top">\n' +
        '    <td align="left">x</td>\n' +
        '  </tr>\n' +
        '</table>\n',
    );
  });

  test('renders title via <caption> and emits user footers', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'col' }],
      rows: [['x']],
    });
    const out = await capture((s) =>
      htmlPrinter.printQuery(
        rs,
        defaultOpts({
          title: 'Report <2024>',
          footers: ['note 1', 'note & 2'],
        }),
        s,
      ),
    );
    expect(out).toContain('<caption>Report &lt;2024&gt;</caption>');
    expect(out).toContain('<p>note 1<br />\nnote &amp; 2<br />\n</p>');
  });
});
