import { describe, test, expect } from 'vitest';

import type { FieldDescription, ResultSet } from '../types/connection.js';
import type { PrintQueryOpts, PrintTableOpts } from '../types/printer.js';

import { csvPrinter } from './csv.js';

const defaultTopt = (overrides?: Partial<PrintTableOpts>): PrintTableOpts => ({
  format: 'csv',
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

describe('csvPrinter', () => {
  test('renders a simple table with header and unquoted plain values', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'id' }, { name: 'name' }],
      rows: [
        [1, 'alice'],
        [2, 'bob'],
        [3, 'carol'],
      ],
    });
    const out = await capture((s) =>
      csvPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe('id,name\n1,alice\n2,bob\n3,carol\n');
  });

  test('quotes values containing the separator, quote, newline, or CR', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
      rows: [['has,comma', 'has"quote', 'has\nnewline', 'has\rcarriage']],
    });
    const out = await capture((s) =>
      csvPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe(
      'a,b,c,d\n' + '"has,comma","has""quote","has\nnewline","has\rcarriage"\n',
    );
  });

  test('renders NULL as the empty default (unquoted)', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [
        [null, 'x'],
        ['y', null],
      ],
    });
    const out = await capture((s) =>
      csvPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe('a,b\n,x\ny,\n');
  });

  test('ignores tuplesOnly — header is always emitted', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'col' }],
      rows: [['x']],
    });
    const out = await capture((s) =>
      csvPrinter.printQuery(
        rs,
        defaultOpts(undefined, { tuplesOnly: true }),
        s,
      ),
    );
    expect(out).toBe('col\nx\n');
  });

  test('honors a custom csv_fieldsep', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [['x;y', 'z']],
    });
    const out = await capture((s) =>
      csvPrinter.printQuery(
        rs,
        defaultOpts(undefined, { csvFieldSep: ';' }),
        s,
      ),
    );
    expect(out).toBe('a;b\n"x;y";z\n');
  });

  test('throws RangeError on invalid csv_fieldsep', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }],
      rows: [['x']],
    });
    await expect(
      capture((s) =>
        csvPrinter.printQuery(
          rs,
          defaultOpts(undefined, { csvFieldSep: '"' }),
          s,
        ),
      ),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      capture((s) =>
        csvPrinter.printQuery(
          rs,
          defaultOpts(undefined, { csvFieldSep: '\n' }),
          s,
        ),
      ),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      capture((s) =>
        csvPrinter.printQuery(
          rs,
          defaultOpts(undefined, { csvFieldSep: ',,' }),
          s,
        ),
      ),
    ).rejects.toBeInstanceOf(RangeError);
  });

  test('always quotes a literal "\\." to dodge the COPY end-of-data marker', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'v' }],
      rows: [['\\.'], ['ok']],
    });
    const out = await capture((s) =>
      csvPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe('v\n"\\."\nok\n');
  });

  test('expanded mode prints colname,value per line', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'id' }, { name: 'name' }],
      rows: [
        [1, 'alice'],
        [2, 'bob,jr'],
      ],
    });
    const out = await capture((s) =>
      csvPrinter.printQuery(rs, defaultOpts(undefined, { expanded: 'on' }), s),
    );
    expect(out).toBe('id,1\nname,alice\nid,2\nname,"bob,jr"\n');
  });
});
