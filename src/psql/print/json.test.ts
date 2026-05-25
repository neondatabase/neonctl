import { describe, test, expect } from 'vitest';

import type { FieldDescription, ResultSet } from '../types/connection.js';
import type { PrintQueryOpts, PrintTableOpts } from '../types/printer.js';

import { jsonPrinter } from './json.js';

const defaultTopt = (overrides?: Partial<PrintTableOpts>): PrintTableOpts => ({
  format: 'json',
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

describe('jsonPrinter', () => {
  test('emits a single-line JSON array by default', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'id', oid: 23 }, { name: 'name' }],
      rows: [
        [1, 'alice'],
        [2, 'bob'],
      ],
    });
    const out = await capture((s) =>
      jsonPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe('[{"id":1,"name":"alice"},{"id":2,"name":"bob"}]\n');
  });

  test('pretty-prints when expanded is on', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a', oid: 23 }],
      rows: [[1]],
    });
    const out = await capture((s) =>
      jsonPrinter.printQuery(rs, defaultOpts(undefined, { expanded: 'on' }), s),
    );
    expect(out).toBe('[\n  {\n    "a": 1\n  }\n]\n');
  });

  test('SQL NULL becomes JSON null', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'v' }],
      rows: [[null], ['x']],
    });
    const out = await capture((s) =>
      jsonPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe('[{"v":null},{"v":"x"}]\n');
  });

  test('parses numeric type OIDs as JSON numbers when round-tripping is safe', async () => {
    const rs = makeResultSet({
      columns: [
        { name: 'i2', oid: 21 },
        { name: 'i4', oid: 23 },
        { name: 'i8', oid: 20 },
        { name: 'f8', oid: 701 },
        { name: 'num', oid: 1700 },
      ],
      rows: [['1', '42', '123', '3.14', '1.500']],
    });
    const out = await capture((s) =>
      jsonPrinter.printQuery(rs, defaultOpts(), s),
    );
    // 1.500 normalizes to "1.5" so it parses as a JSON number; the
    // String(parsed) round-trip matches.
    expect(out).toBe('[{"i2":1,"i4":42,"i8":123,"f8":3.14,"num":1.5}]\n');
  });

  test('preserves NUMERIC values that exceed JS number precision as strings', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'big', oid: 1700 }],
      rows: [['9999999999999999999999.5']],
    });
    const out = await capture((s) =>
      jsonPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe('[{"big":"9999999999999999999999.5"}]\n');
  });

  test('non-numeric typed strings stay strings', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'note', oid: 25 }],
      rows: [['42']],
    });
    const out = await capture((s) =>
      jsonPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe('[{"note":"42"}]\n');
  });

  test('renders booleans, dates, and bytea naturally', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'ok' }, { name: 'when' }, { name: 'bin' }],
      rows: [
        [
          true,
          new Date('2024-01-02T03:04:05.678Z'),
          new Uint8Array([0xde, 0xad]),
        ],
      ],
    });
    const out = await capture((s) =>
      jsonPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe(
      '[{"ok":true,"when":"2024-01-02T03:04:05.678Z","bin":"\\\\xdead"}]\n',
    );
  });

  test('empty rowset is an empty array', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }],
      rows: [],
    });
    const out = await capture((s) =>
      jsonPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe('[]\n');
  });
});
