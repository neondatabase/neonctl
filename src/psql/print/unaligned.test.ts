import { describe, test, expect } from 'vitest';

import type { FieldDescription, ResultSet } from '../types/connection.js';
import type { PrintQueryOpts, PrintTableOpts } from '../types/printer.js';

import { unalignedPrinter } from './unaligned.js';

const defaultTopt = (overrides?: Partial<PrintTableOpts>): PrintTableOpts => ({
  format: 'unaligned',
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
    dataTypeID: c.oid ?? 25, // text
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

describe('unalignedPrinter', () => {
  test('renders a standard table with header, body, and default footer', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'id' }, { name: 'name' }, { name: 'note' }],
      rows: [
        [1, 'alice', 'hello'],
        [2, 'bob', null],
        [3, 'carol', 'world'],
      ],
    });
    const out = await capture((s) =>
      unalignedPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe(
      'id|name|note\n' +
        '1|alice|hello\n' +
        '2|bob|\n' +
        '3|carol|world\n' +
        '(3 rows)\n',
    );
  });

  test('honors custom field and record separators', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [
        ['x', 'y'],
        ['z', 'w'],
      ],
    });
    const out = await capture((s) =>
      unalignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, {
          fieldSep: '\t',
          recordSep: ';',
          defaultFooter: false,
        }),
        s,
      ),
    );
    expect(out).toBe('a\tb;x\ty;z\tw;');
  });

  test('omits header and footer when tuplesOnly is set', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }],
      rows: [['x'], ['y']],
    });
    const out = await capture((s) =>
      unalignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, { tuplesOnly: true }),
        s,
      ),
    );
    expect(out).toBe('x\ny\n');
  });

  test('renders NULL using nullPrint', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'v' }],
      rows: [[null], ['set'], [null]],
    });
    const out = await capture((s) =>
      unalignedPrinter.printQuery(rs, defaultOpts({ nullPrint: '(null)' }), s),
    );
    expect(out).toBe('v\n(null)\nset\n(null)\n(3 rows)\n');
  });

  test('expanded mode prints colname|value per line with blank record gap', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'id' }, { name: 'name' }],
      rows: [
        [1, 'alice'],
        [2, 'bob'],
      ],
    });
    const out = await capture((s) =>
      unalignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, { expanded: 'on' }),
        s,
      ),
    );
    expect(out).toBe('id|1\nname|alice\n\nid|2\nname|bob\n');
  });

  test('emits singular "(1 row)" footer when row count is one', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }],
      rows: [['x']],
    });
    const out = await capture((s) =>
      unalignedPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe('a\nx\n(1 row)\n');
  });

  test('respects numericLocale when on', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'n', oid: 20 }],
      rows: [[1234567], ['9876543.21']],
    });
    const out = await capture((s) =>
      unalignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, { numericLocale: true }),
        s,
      ),
    );
    // Default host locale; we only assert that grouping happened by
    // checking the absence of a bare "1234567" / "9876543" in the body.
    expect(out).not.toContain('1234567');
    expect(out).not.toContain('9876543.21');
    expect(out).toContain('\n(2 rows)\n');
  });
});
