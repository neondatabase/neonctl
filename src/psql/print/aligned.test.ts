import { describe, test, expect } from 'vitest';

import type { FieldDescription, ResultSet } from '../types/connection.js';
import type { PrintQueryOpts, PrintTableOpts } from '../types/printer.js';

import {
  alignedPrinter,
  computeColumnWidths,
  displayWidth,
  padToWidth,
} from './aligned.js';

const defaultTopt = (overrides?: Partial<PrintTableOpts>): PrintTableOpts => ({
  format: 'aligned',
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
  columns: 0,
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

describe('displayWidth', () => {
  test('counts ASCII as 1', () => {
    expect(displayWidth('hello')).toBe(5);
  });

  test('counts CJK as 2', () => {
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('a中b')).toBe(4);
  });

  test('counts combining marks as 0', () => {
    // e + combining acute accent = 1, not 2.
    expect(displayWidth('é')).toBe(1);
  });

  test('counts zero-width joiner as 0', () => {
    expect(displayWidth('a‍b')).toBe(2);
  });

  test('handles surrogate pairs (one emoji)', () => {
    // U+1F600 grinning face, in the wide range.
    expect(displayWidth('\u{1F600}')).toBe(2);
  });
});

describe('padToWidth', () => {
  test('left aligns', () => {
    expect(padToWidth('hi', 5, 'left')).toBe('hi   ');
  });
  test('right aligns', () => {
    expect(padToWidth('hi', 5, 'right')).toBe('   hi');
  });
  test('centers, biases extra to right', () => {
    expect(padToWidth('hi', 5, 'center')).toBe(' hi  ');
  });
  test('respects east asian width when padding', () => {
    // 中 is width 2, so to fit in width 4 we need 2 spaces.
    expect(padToWidth('中', 4, 'left')).toBe('中  ');
  });
});

describe('computeColumnWidths', () => {
  test('uses header width when wider than any value', () => {
    const rs = makeResultSet({
      columns: [{ name: 'longer_name' }, { name: 'b' }],
      rows: [
        ['x', 'y'],
        ['z', 'longer-value'],
      ],
    });
    const widths = computeColumnWidths(rs, defaultTopt());
    expect(widths).toEqual([11, 12]);
  });
});

describe('alignedPrinter horizontal mode', () => {
  test('border=1 renders standard table with header rule and footer', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'id', oid: 23 }, { name: 'name' }],
      rows: [
        [1, 'alice'],
        [2, 'bob'],
      ],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe(
      ' id | name  \n' +
        '----+-------\n' +
        '  1 | alice \n' +
        '  2 | bob   \n' +
        '(2 rows)\n',
    );
  });

  test('border=0 separates columns with single space', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [
        ['x', 'y'],
        ['zz', 'ww'],
      ],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(rs, defaultOpts(undefined, { border: 0 }), s),
    );
    expect(out).toBe(
      'a  b \n' + '-- --\n' + 'x  y \n' + 'zz ww\n' + '(2 rows)\n',
    );
  });

  test('border=2 wraps in full box', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [['x', 'y']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(rs, defaultOpts(undefined, { border: 2 }), s),
    );
    expect(out).toBe(
      '+---+---+\n' +
        '| a | b |\n' +
        '+---+---+\n' +
        '| x | y |\n' +
        '+---+---+\n' +
        '(1 row)\n',
    );
  });

  test('right-aligns numeric columns by OID', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'n', oid: 20 }, { name: 'label' }],
      rows: [
        [1, 'one'],
        [222, 'twohundred'],
      ],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toBe(
      '  n  |   label    \n' +
        '-----+------------\n' +
        '   1 | one        \n' +
        ' 222 | twohundred \n' +
        '(2 rows)\n',
    );
  });

  test('renders NULL with custom nullPrint', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'v' }],
      rows: [[null], ['set']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(rs, defaultOpts({ nullPrint: '∅' }), s),
    );
    expect(out).toBe(
      '  v  \n' + '-----\n' + ' ∅   \n' + ' set \n' + '(2 rows)\n',
    );
  });

  test('pluralizes (1 row)', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }],
      rows: [['x']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out.endsWith('(1 row)\n')).toBe(true);
    expect(out).not.toContain('(1 rows)');
  });

  test('empty result still prints header and (0 rows)', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(rs, defaultOpts(), s),
    );
    expect(out).toContain('(0 rows)\n');
    expect(out).toContain(' a ');
    expect(out).toContain(' b ');
  });

  test('tuplesOnly suppresses header rule and footer', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }],
      rows: [['x'], ['y']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, { tuplesOnly: true }),
        s,
      ),
    );
    expect(out).toBe(' x \n y \n');
  });

  test('east-asian wide chars are padded correctly', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'name' }],
      rows: [['中文'], ['abc']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(rs, defaultOpts(), s),
    );
    // Both rows should align: 中文 is 4 cols, abc is 3 cols, so col width is 4.
    expect(out).toBe(
      ' name \n' + '------\n' + ' 中文 \n' + ' abc  \n' + '(2 rows)\n',
    );
  });

  test('respects numericLocale grouping for numeric columns', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'n', oid: 20 }],
      rows: [[1234567]],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, { numericLocale: true }),
        s,
      ),
    );
    // Bare "1234567" should not appear; grouping happened.
    expect(out).not.toContain('1234567 ');
    expect(out).toContain('(1 row)');
  });
});

describe('alignedPrinter expanded mode', () => {
  test('border=2 renders RECORD blocks with full box', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'id' }, { name: 'name' }],
      rows: [
        [1, 'alice'],
        [2, 'bob'],
      ],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, { expanded: 'on', border: 2 }),
        s,
      ),
    );
    expect(out).toContain('[ RECORD 1 ]');
    expect(out).toContain('[ RECORD 2 ]');
    expect(out).toMatch(/\| id\s+\| 1\s+\|/);
    expect(out).toMatch(/\| name\s+\| alice\s+\|/);
    expect(out.endsWith('(2 rows)\n')).toBe(true);
  });

  test('border=1 uses + junction without outer rule', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'k' }, { name: 'v' }],
      rows: [['key', 'value']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, { expanded: 'on', border: 1 }),
        s,
      ),
    );
    expect(out).toContain('-[ RECORD 1 ]');
    expect(out).toContain('+');
    expect(out).toContain('k | key');
    expect(out).toContain('v | value');
  });

  test('auto picks vertical when horizontal would exceed columns', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      rows: [
        [
          'long-value-aaaaaaaaaaaaaaaaa',
          'long-value-bbbbbbbbbbbbbbbbb',
          'long-value-ccccccccccccccccc',
        ],
      ],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, {
          expanded: 'auto',
          columns: 40,
          envColumns: 40,
        }),
        s,
      ),
    );
    expect(out).toContain('[ RECORD 1 ]');
  });
});

describe('alignedPrinter wrapped mode', () => {
  test('wraps long cells with leading dot on continuation', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [['abcdefghij', 'short']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, {
          format: 'wrapped',
          border: 2,
          columns: 15,
          envColumns: 15,
        }),
        s,
      ),
    );
    // Cell got broken into multiple lines with dot gutter.
    expect(out).toContain('.');
    // Original characters should all be present.
    expect(out).toContain('abc');
  });
});

describe('alignedPrinter unicode mode', () => {
  test('uses unicode box-drawing glyphs when configured', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [['x', 'y']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, {
          border: 2,
          unicodeBorderLineStyle: 'unicode',
        }),
        s,
      ),
    );
    expect(out).toContain('┌');
    expect(out).toContain('┐');
    expect(out).toContain('└');
    expect(out).toContain('┘');
    expect(out).toContain('│');
    expect(out).toContain('─');
  });
});
