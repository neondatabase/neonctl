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
        '(2 rows)\n' +
        '\n',
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
      'a  b \n' + '-- --\n' + 'x  y \n' + 'zz ww\n' + '(2 rows)\n' + '\n',
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
        '(1 row)\n' +
        '\n',
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
        '(2 rows)\n' +
        '\n',
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
      '  v  \n' + '-----\n' + ' ∅   \n' + ' set \n' + '(2 rows)\n' + '\n',
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
    // Footer is followed by a trailing blank line per upstream parity.
    expect(out.endsWith('(1 row)\n\n')).toBe(true);
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
      ' name \n' + '------\n' + ' 中文 \n' + ' abc  \n' + '(2 rows)\n' + '\n',
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
    // Expanded mode emits no `(N rows)` footer (upstream parity).
    expect(out.endsWith('(2 rows)\n')).toBe(false);
    expect(out.endsWith('\n')).toBe(true);
  });

  test('border=1 renders short-column RECORD header without + divider', async () => {
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
    // When the `[ RECORD N ]` label already overflows the left segment
    // (short column names), upstream emits just the label with the dash
    // prefix and omits the `+<right-segment>` divider. Verified against
    // vanilla psql 18: `SELECT 'key' as k, 'value' as v \gx` emits
    // `-[ RECORD 1 ]` with no trailing `+---`.
    expect(out).toContain('-[ RECORD 1 ]');
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

  test('ratio-scoring picks the high-variance column to shrink', async () => {
    // Two columns at equal max width (13 chars) but with very different
    // value variance:
    //   - col `a` is uniformly wide (every row is 'xxxxxxxxxxxxx')
    //   - col `b` has one wide outlier and three narrow rows
    //
    // Greedy `shrink-widest-first` is ambiguous when widths tie; with the
    // ratio formula `width/avg + max*0.01`, column `b` wins because
    // shrinking it costs at most 1 wrapped row, while shrinking `a` would
    // wrap every row.
    //
    // Target width 20 cols forces ~11 chars of total shrink (full layout
    // would be 31 cols including the border=1 gutters).
    const wideA = 'x'.repeat(13);
    const wideB = 'y'.repeat(13);
    const narrowB = 'y';
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [
        [wideA, wideB],
        [wideA, narrowB],
        [wideA, narrowB],
        [wideA, narrowB],
      ],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, {
          format: 'wrapped',
          border: 1,
          columns: 20,
          envColumns: 20,
        }),
        s,
      ),
    );
    // Column `a` was NOT shrunk — every one of the 4 data rows shows the
    // full 13-char `xxxxxxxxxxxxx` value once on its own physical line.
    const aLines = out.split('\n').filter((l) => l.includes(wideA));
    expect(aLines.length).toBe(4);
    // Column `b`'s wide outlier wrapped across multiple display lines:
    // there must be more total output lines than data rows.
    const dataLines = out
      .split('\n')
      .filter((l) => l.includes('y') || l.includes('x'));
    expect(dataLines.length).toBeGreaterThan(4);
  });

  test('right-aligns xid8 and pg_lsn by OID', async () => {
    // xid8 = OID 5069, pg_lsn = OID 3220. Both should be right-aligned
    // even though they're contrib/extension-y "numeric-ish" types.
    const rs = makeResultSet({
      columns: [
        { name: 'xmin', oid: 5069 },
        { name: 'lsn', oid: 3220 },
        { name: 'label' },
      ],
      rows: [
        ['12345', '0/1A2B3C4D', 'a'],
        ['7', '0/0', 'longer-label'],
      ],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(rs, defaultOpts(), s),
    );
    // xid8 value '7' should be right-aligned within its column.
    // The shorter value '7' should have padding on the LEFT (right-align).
    const lines = out.split('\n');
    const row7 = lines.find((l) => l.includes(' 7 ') && l.includes('0/0'));
    expect(row7).toBeDefined();
    // Verify "7" follows whitespace (right-aligned), not "7 " (left-aligned).
    expect(row7).toMatch(/ {2,}7 \|/);
    // Verify pg_lsn '0/0' is right-aligned vs '0/1A2B3C4D'.
    expect(row7).toMatch(/\| {2,}0\/0 \|/);
  });
});

describe('alignedPrinter unicode linestyle variants', () => {
  test('unicode mode emits the full box-drawing glyph set', async () => {
    // Snapshot-style assertion for a small 2x2 grid with border=2 (full box)
    // so we exercise every glyph in the Glyphs struct.
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [
        ['x', 'y'],
        ['z', 'w'],
      ],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, {
          border: 2,
          unicodeBorderLineStyle: 'unicode',
          unicodeColumnLineStyle: 'unicode',
          unicodeHeaderLineStyle: 'unicode',
        }),
        s,
      ),
    );
    expect(out).toBe(
      '┌───┬───┐\n' +
        '│ a │ b │\n' +
        '├───┼───┤\n' +
        '│ x │ y │\n' +
        '│ z │ w │\n' +
        '└───┴───┘\n' +
        '(2 rows)\n' +
        '\n',
    );
  });

  test('unicode border=1 uses middle-junction glyphs (no outer box)', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'k' }, { name: 'v' }],
      rows: [['a', '1']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, {
          border: 1,
          unicodeBorderLineStyle: 'unicode',
        }),
        s,
      ),
    );
    // border=1 still uses the middle T-junction for the header rule even
    // though we don't draw the outer box. Vertical column rule is │.
    expect(out).toContain('│'); // column rule
    expect(out).toContain('─'); // header underline
    expect(out).toContain('┼'); // cross at header-rule × column-rule
    // No outer-box glyphs.
    expect(out).not.toContain('┌');
    expect(out).not.toContain('┘');
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
