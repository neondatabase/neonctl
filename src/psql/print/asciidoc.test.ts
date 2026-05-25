import { describe, test, expect } from 'vitest';

import type { FieldDescription, ResultSet } from '../types/connection.js';
import type { PrintQueryOpts, PrintTableOpts } from '../types/printer.js';

import { asciidocPrinter } from './asciidoc.js';

const defaultTopt = (overrides?: Partial<PrintTableOpts>): PrintTableOpts => ({
  format: 'asciidoc',
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

describe('asciidocPrinter', () => {
  test('renders a 3x3 table with numeric column right-aligned (border=1)', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'id', oid: 23 }, { name: 'name' }, { name: 'val' }],
      rows: [
        [1, 'alice', 'x'],
        [2, 'bob', 'y'],
        [3, 'carol', 'z'],
      ],
    });
    const out = await capture((s) =>
      asciidocPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe(
      '\n' +
        '[options="header",cols=">l,<l,<l",frame="none"]\n' +
        '|====\n' +
        '^l|id ^l|name ^l|val\n' +
        '|1 |alice |x\n' +
        '|2 |bob |y\n' +
        '|3 |carol |z\n' +
        '|====\n' +
        '\n....\n(3 rows)\n....\n',
    );
  });

  test('border=0 emits frame/grid none, border=2 emits all/all', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }],
      rows: [['x']],
    });

    const b0 = await capture((s) =>
      asciidocPrinter.printQuery(
        rs,
        defaultOpts(undefined, { border: 0, defaultFooter: false }),
        s,
      ),
    );
    expect(b0).toContain('cols="<l",frame="none",grid="none"');

    const b2 = await capture((s) =>
      asciidocPrinter.printQuery(
        rs,
        defaultOpts(undefined, { border: 2, defaultFooter: false }),
        s,
      ),
    );
    expect(b2).toContain('cols="<l",frame="all",grid="all"');
  });

  test('escapes | with \\|', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a|b' }],
      rows: [['x|y']],
    });
    const out = await capture((s) =>
      asciidocPrinter.printQuery(
        rs,
        defaultOpts(undefined, { defaultFooter: false }),
        s,
      ),
    );
    expect(out).toContain('^l|a\\|b');
    expect(out).toContain('|x\\|y');
  });

  test('passes newlines through (AsciiDoc continues a cell)', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }],
      rows: [['line1\nline2']],
    });
    const out = await capture((s) =>
      asciidocPrinter.printQuery(
        rs,
        defaultOpts(undefined, { defaultFooter: false }),
        s,
      ),
    );
    expect(out).toContain('|line1\nline2\n');
  });

  test('whitespace-only cell renders as bare separator', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [['', 'x']],
    });
    const out = await capture((s) =>
      asciidocPrinter.printQuery(
        rs,
        defaultOpts(undefined, { defaultFooter: false }),
        s,
      ),
    );
    // Empty first-column cell: `|` + trailing space (not the last cell).
    // Then the inter-cell space, then `|x` for the second column. The
    // two adjacent spaces are exactly upstream's behavior.
    expect(out).toContain('|  |x\n');
  });

  test('empty result still emits header row and (0 rows) footer', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'col' }],
      rows: [],
    });
    const out = await capture((s) =>
      asciidocPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe(
      '\n' +
        '[options="header",cols="<l",frame="none"]\n' +
        '|====\n' +
        '^l|col\n' +
        '|====\n' +
        '\n....\n(0 rows)\n....\n',
    );
  });

  test('tuplesOnly drops title, header, and footer', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'col' }],
      rows: [['x']],
    });
    const out = await capture((s) =>
      asciidocPrinter.printQuery(
        rs,
        defaultOpts({ title: 'T' }, { tuplesOnly: true }),
        s,
      ),
    );
    expect(out).toBe(
      '\n' + '[cols="<l",frame="none"]\n' + '|====\n' + '|x\n' + '|====\n',
    );
  });

  test('renders title and user footers', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'col' }],
      rows: [['x']],
    });
    const out = await capture((s) =>
      asciidocPrinter.printQuery(
        rs,
        defaultOpts({
          title: 'My Title',
          footers: ['footer a', 'footer b'],
        }),
        s,
      ),
    );
    expect(out).toContain('.My Title\n');
    expect(out).toContain('\n....\nfooter a\nfooter b\n....\n');
  });
});
