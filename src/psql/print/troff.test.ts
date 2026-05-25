import { describe, test, expect } from 'vitest';

import type { FieldDescription, ResultSet } from '../types/connection.js';
import type { PrintQueryOpts, PrintTableOpts } from '../types/printer.js';

import { troffMsPrinter } from './troff.js';

const defaultTopt = (overrides?: Partial<PrintTableOpts>): PrintTableOpts => ({
  format: 'troff-ms',
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

describe('troffMsPrinter', () => {
  test('renders a 3x3 table with numeric column right-aligned', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'id', oid: 23 }, { name: 'name' }, { name: 'val' }],
      rows: [
        [1, 'alice', 'x'],
        [2, 'bob', 'y'],
        [3, 'carol', 'z'],
      ],
    });
    const out = await capture((s) =>
      troffMsPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe(
      '.LP\n.TS\n' +
        'center;\n' +
        'r | l | l.\n' +
        '\\fIid\\fP\t\\fIname\\fP\t\\fIval\\fP\n' +
        '_\n' +
        '1\talice\tx\n' +
        '2\tbob\ty\n' +
        '3\tcarol\tz\n' +
        '.TE\n.DS L\n' +
        '(3 rows)\n' +
        '.DE\n',
    );
  });

  test('border=0 omits column separators; border=2 uses center box', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [['x', 'y']],
    });

    const b0 = await capture((s) =>
      troffMsPrinter.printQuery(
        rs,
        defaultOpts(undefined, { border: 0, defaultFooter: false }),
        s,
      ),
    );
    expect(b0).toContain('center;\nll.\n');

    const b2 = await capture((s) =>
      troffMsPrinter.printQuery(
        rs,
        defaultOpts(undefined, { border: 2, defaultFooter: false }),
        s,
      ),
    );
    expect(b2).toContain('center box;\nl | l.\n');
  });

  test('escapes \\\\ to \\(rs', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }],
      rows: [['back\\slash']],
    });
    const out = await capture((s) =>
      troffMsPrinter.printQuery(
        rs,
        defaultOpts(undefined, { defaultFooter: false }),
        s,
      ),
    );
    expect(out).toContain('back\\(rsslash\n');
  });

  test('empty result emits scaffold and (0 rows) footer', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'col' }],
      rows: [],
    });
    const out = await capture((s) =>
      troffMsPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe(
      '.LP\n.TS\n' +
        'center;\n' +
        'l.\n' +
        '\\fIcol\\fP\n' +
        '_\n' +
        '.TE\n.DS L\n' +
        '(0 rows)\n' +
        '.DE\n',
    );
  });

  test('tuplesOnly drops title, headers, footers', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'col' }],
      rows: [['x']],
    });
    const out = await capture((s) =>
      troffMsPrinter.printQuery(
        rs,
        defaultOpts({ title: 'T' }, { tuplesOnly: true }),
        s,
      ),
    );
    expect(out).toBe(
      '.LP\n.TS\n' + 'center;\n' + 'l.\n' + 'x\n' + '.TE\n.DS L\n' + '.DE\n',
    );
  });

  test('renders title in .DS C block and user footers', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'col' }],
      rows: [['x']],
    });
    const out = await capture((s) =>
      troffMsPrinter.printQuery(
        rs,
        defaultOpts({
          title: 'My Title',
          footers: ['note one', 'note two'],
        }),
        s,
      ),
    );
    expect(out.startsWith('.LP\n.DS C\nMy Title\n.DE\n.LP\n.TS\n')).toBe(true);
    expect(out).toContain('.TE\n.DS L\nnote one\nnote two\n.DE\n');
  });
});
