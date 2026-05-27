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
        '  1 | alice\n' +
        '  2 | bob\n' +
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
    // Border 0 with ascii format has `wrap_right_border = true` upstream,
    // so `print_aligned_text` emits a `header_nl_right` marker (a plain
    // space for done cells) after the LAST header cell as well as between
    // cells. The header row therefore ends in two trailing spaces:
    // one from the last cell's centred padding plus the trailing margin.
    expect(out).toBe(
      'a  b  \n' + '-- --\n' + 'x  y\n' + 'zz ww\n' + '(2 rows)\n' + '\n',
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
        '   1 | one\n' +
        ' 222 | twohundred\n' +
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
      '  v  \n' + '-----\n' + ' ∅\n' + ' set\n' + '(2 rows)\n' + '\n',
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
    expect(out).toBe(' x\n y\n');
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
      ' name \n' + '------\n' + ' 中文\n' + ' abc\n' + '(2 rows)\n' + '\n',
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

  test('ratio-scoring picks the high-variance column to shrink first', async () => {
    // Two columns at equal max width (13 chars) but with very different
    // value variance:
    //   - col `a` is uniformly wide (every row is 'xxxxxxxxxxxxx')
    //   - col `b` has one wide outlier and three narrow rows
    //
    // The ratio formula `width/avg + max*0.01` makes column `b` the
    // initial victim (avg≈4 for `b` vs 13 for `a`, ratio ≈ 3.4 vs 1.1),
    // so shrinking proceeds on `b` until it bottoms out at its header
    // floor. Only then does the algorithm peel chars off `a`.
    //
    // Target width 20 (border=1 overhead is `3n - 1 = 5`, mirroring
    // upstream `print.c` width_total at lines 763-769). Initial total
    // is 31, so 11 chars must be shed. `b` can drop from 13 down to its
    // 1-char header (12 reductions), leaving 10 → still 1 short, so
    // `a` shrinks by 1 to a=12. Verified byte-for-byte against vanilla
    // psql 18 (`\pset columns 20 \pset format wrapped`).
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
    const lines = out.split('\n');
    // Column `a` shrunk from 13 → 12: each data row of `a` now wraps
    // into ` xxxxxxxxxxxx.` (12 x's + wrap_right marker) plus a `.x`
    // continuation line. Column `b` shrunk hard — narrow `y` rows render
    // on a single line (` y ...`), the wide outlier wraps onto five
    // physical lines.
    expect(lines).toContain(' xxxxxxxxxxxx.| yyy.');
    expect(lines).toContain('.x            |.yyy.');
    // Three narrow-b rows render as: a wraps (2 lines), b shows ` y` once.
    // So the total data-line count is 4*2 (for `a` wrap) + 4 extra lines
    // for the wideB cell — at minimum strictly > 4 rows.
    const dataLines = lines.filter((l) => l.includes('y') || l.includes('x'));
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

// Trailing-whitespace cosmetic parity with vanilla psql 18. Verified
// byte-for-byte by `cat -e` / `sed -n l` against `psql --no-psqlrc -X`.
describe('alignedPrinter trailing-whitespace parity', () => {
  test('border=1 header keeps trailing space on right margin', async () => {
    // Two text columns with data that determines the column width. The
    // header row must end in a literal space (the right margin emitted
    // by upstream `print_aligned_text` when border != 0).
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [['x', 'y']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(rs, defaultOpts(), s),
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe(' a | b ');
    // Data rows do NOT have a trailing space (last column padding is skipped).
    expect(lines[2]).toBe(' x | y');
  });

  test('border=1 right-aligned last column has no trailing pad on data', async () => {
    // Single column, right-aligned numeric. Vanilla emits ` 12345` /
    // ` 7` with no trailing whitespace on data rows.
    const rs = makeResultSet({
      columns: [{ name: 'n', oid: 23 }],
      rows: [[12345], [7]],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(rs, defaultOpts(), s),
    );
    const lines = out.split('\n');
    // Header centred in width 5, with a trailing margin space.
    expect(lines[0]).toBe('   n   ');
    expect(lines[2]).toBe(' 12345');
    expect(lines[3]).toBe('     7');
  });

  test('border=0 header keeps trailing space (wrap_right_border)', async () => {
    // With ascii format the `wrap_right_border` flag is true upstream, so
    // border=0 still emits a `header_nl_right` marker after the LAST
    // header cell — a space when the cell has no more lines below.
    // Verified against vanilla psql 18 with `\pset border 0`.
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [['x', 'y']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(rs, defaultOpts(undefined, { border: 0 }), s),
    );
    const lines = out.split('\n');
    // Header: column width = 1, centred = `a`, plus separator ` `, plus
    // `b`, plus trailing margin space.
    expect(lines[0]).toBe('a b ');
    // Data: no trailing margin.
    expect(lines[2]).toBe('x y');
  });

  test('expanded border=0 record header pads to nameWidth+valueWidth', async () => {
    // Upstream `print_aligned_vertical_line` (border 0 branch, print.c
    // ~lines 1243-1281) pads `* Record N` with spaces to reach
    // `hwidth + dwidth` characters. Long names + short values:
    //   name col `longname` / `longvalue` → hwidth = 9
    //   value col `key` / `value`          → dwidth = 5
    //   target = 14, label `* Record 1` is 10 → 4 trailing spaces.
    const rs = makeResultSet({
      columns: [{ name: 'longname' }, { name: 'longvalue' }],
      rows: [['key', 'value']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, { expanded: 'on', border: 0 }),
        s,
      ),
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('* Record 1    ');
    // Data lines: name padded to hwidth, then single space, then bare
    // value (no trailing pad).
    expect(lines[1]).toBe('longname  key');
    expect(lines[2]).toBe('longvalue value');
  });

  test('expanded border=0 long label is not truncated', async () => {
    // When the `* Record N` label already meets or exceeds
    // `hwidth + dwidth`, upstream emits the bare label with no padding.
    // Force this by giving very short column widths.
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [['1', '2']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, { expanded: 'on', border: 0 }),
        s,
      ),
    );
    const lines = out.split('\n');
    // hwidth=1, dwidth=1, target=2, label=`* Record 1` (10 chars) overflows.
    expect(lines[0]).toBe('* Record 1');
  });

  test('expanded border=1 data line emits no trailing value pad', async () => {
    // Upstream `print_aligned_vertical` only pads the value column for
    // border > 1. For border=1 the data line ends right after the bare
    // value bytes — vanilla emits `longname  | key` not `longname  | key  `.
    const rs = makeResultSet({
      columns: [{ name: 'longname' }, { name: 'longvalue' }],
      rows: [['key', 'value']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, { expanded: 'on', border: 1 }),
        s,
      ),
    );
    const lines = out.split('\n');
    // Data lines (skip the `-[ RECORD ]` divider on line 0).
    expect(lines[1]).toBe('longname  | key');
    expect(lines[2]).toBe('longvalue | value');
  });

  test('expanded border=1 right-aligned values are emitted left-aligned without pad', async () => {
    // Vertical mode upstream always emits raw bytes in the data column
    // regardless of `cont->aligns[j]` — numeric columns are not right-
    // aligned in expanded mode. And there is no trailing pad for border 1.
    const rs = makeResultSet({
      columns: [
        { name: 'small', oid: 23 },
        { name: 'big', oid: 23 },
      ],
      rows: [[1, 999999]],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, { expanded: 'on', border: 1 }),
        s,
      ),
    );
    const lines = out.split('\n');
    // Both values rendered left-aligned (the integer is just stringified),
    // and no trailing padding spaces after either value.
    expect(lines[1]).toBe('small | 1');
    expect(lines[2]).toBe('big   | 999999');
  });

  test('expanded border=1 record header pads to row width when label overflows left segment', async () => {
    // Upstream `print_aligned_vertical_line` pads the `[ RECORD N ]`
    // label with hrules out to the FULL data-row width when the label
    // overflows the pre-`|` segment but still fits within the row. The
    // mid `+` junction is dropped in this case. Verified against vanilla
    // psql 18: `SELECT 'x' as a, 'value here' as bb \gx` (nameWidth=2,
    // valueWidth=10) emits `-[ RECORD 1 ]--` — 2 trailing dashes pad
    // out to the data-row width (`bb | value here` = 15 chars).
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'bb' }],
      rows: [['x', 'value here']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, { expanded: 'on', border: 1 }),
        s,
      ),
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('-[ RECORD 1 ]--');
    expect(lines[1]).toBe('a  | x');
    expect(lines[2]).toBe('bb | value here');
  });

  test('expanded border=1 record header emits `+` junction aligned with data `|`', async () => {
    // When the `[ RECORD N ]` label fits within the pre-`|` segment
    // (long name column), upstream pads the label-prefix with hrules
    // to leftSpan = nameWidth + 1 chars, then emits the mid `+`
    // junction at the same column as the data `|`, then enough hrules
    // to fill the trailing valueWidth + 1 chars. Verified against
    // vanilla psql 18: `SELECT 'a' as widename_col_one, 'b' as another_widename_two \gx`
    // (nameWidth=20) emits `-[ RECORD 1 ]--------+--` with the `+` at
    // position 22, matching the `|` in `widename_col_one     | a`.
    const rs = makeResultSet({
      columns: [{ name: 'widename_col_one' }, { name: 'another_widename_two' }],
      rows: [['a', 'b']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, { expanded: 'on', border: 1 }),
        s,
      ),
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('-[ RECORD 1 ]--------+--');
    // Confirm `+` and `|` columns align.
    const recordHdr = lines[0];
    const dataLine = lines[1];
    expect(recordHdr.indexOf('+')).toBe(dataLine.indexOf('|'));
  });

  test('expanded border=2 record header uses top corners on first record, mid on subsequent', async () => {
    // For border 2, upstream uses the TOP glyph set (`┌`, `┬`, `┐` in
    // unicode; all `+` in ASCII) on the first record header — the rule
    // looks like a normal table-top — and the MID glyph set (`├`, `┼`,
    // `┤`) on subsequent records — the rule looks like an inter-row
    // separator. Verified against vanilla psql 18 with
    // `\pset linestyle unicode`. ASCII collapses to `+` everywhere so
    // we test the unicode glyphs to lock in the distinction.
    const rs = makeResultSet({
      columns: [{ name: 'one' }, { name: 'two' }],
      rows: [
        [1, 2],
        [3, 4],
      ],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, {
          expanded: 'on',
          border: 2,
          unicodeBorderLineStyle: 'unicode',
          unicodeColumnLineStyle: 'unicode',
          unicodeHeaderLineStyle: 'unicode',
        }),
        s,
      ),
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('┌─[ RECORD 1 ]─┐');
    // Second record uses MID glyphs.
    const secondRecord = lines.find((l) => l.includes('[ RECORD 2 ]'));
    expect(secondRecord).toBe('├─[ RECORD 2 ]─┤');
  });

  test('expanded border=2 record header omits mid junction when label overflows left segment', async () => {
    // When the `[ RECORD N ]` label is wider than the left segment but
    // narrower than the natural row, upstream drops the mid junction
    // and pads with hrules between the outer corners out to the full
    // row width. Verified against vanilla psql 18:
    // `SELECT 1 as one, 234567890 as two \gx \pset border 2` emits
    // `+-[ RECORD 1 ]----+` (19 chars, no mid `+`).
    const rs = makeResultSet({
      columns: [
        { name: 'one', oid: 23 },
        { name: 'two', oid: 23 },
      ],
      rows: [[1, 234567890]],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, { expanded: 'on', border: 2 }),
        s,
      ),
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('+-[ RECORD 1 ]----+');
    // Verify no mid `+` between the corners. Strip the outer `+`s.
    const inner = lines[0].slice(1, -1);
    expect(inner.includes('+')).toBe(false);
  });

  test('expanded border=2 record header embeds mid junction when label fits left segment', async () => {
    // With wider columns (left segment >= 1 + label.length), upstream
    // emits `topLeft + hrule + label + hrules-to-leftSegLen + topMid +
    // hrules(rightSegLen) + topRight`. Verified against vanilla psql 18:
    // `SELECT 'a longer label here' as alongcolname, 1 as b \gx \pset border 2`
    // emits `+-[ RECORD 1 ]-+---------------------+`.
    const rs = makeResultSet({
      columns: [{ name: 'alongcolname' }, { name: 'b' }],
      rows: [['a longer label here', '1']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, { expanded: 'on', border: 2 }),
        s,
      ),
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe('+-[ RECORD 1 ]-+---------------------+');
  });
});

// Multi-line / wrap marker parity. Verifies the `+` (nl) and `.` (wrap)
// continuation indicators land in the correct slots — between cell
// content and column separator on the row that has more content, with
// matching `.` in the leading gutter of the wrap-continuation row.
describe('alignedPrinter multi-line and wrap markers', () => {
  test('embedded \\n splits header across lines with `+` between content and separator', async () => {
    // Two columns, second header has an embedded `\n`. Upstream
    // `print_aligned_text` emits `header_nl_right` (`+` for ASCII) on
    // every line whose column still has more lines below. With
    // wrap_right_border=true, the marker is also emitted at the
    // trailing edge of the LAST column. Verified against vanilla psql 18.
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b\nc' }],
      rows: [['x', 'y']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(rs, defaultOpts(), s),
    );
    const lines = out.split('\n');
    // Header line 1: `a` centered in width 1, `b` centered in width 1.
    // Both columns have more lines below, so both get `+` markers.
    expect(lines[0]).toBe(' a | b+');
    // Header line 2: `a` is done (empty), `c` is the last line for col b.
    expect(lines[1]).toBe('   | c ');
  });

  test('embedded \\n in data row emits `+` continuation in column separator slot', async () => {
    // Data rows with `\n` cells: upstream pads the cell to full width
    // (even on the last column) and emits `nl_right` (`+`) on the
    // continuation side. The next physical line shows the trailing
    // content (no leading `.`, since this is a newline-continuation,
    // not a wrap).
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [['line1\nline2', 'x']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(rs, defaultOpts(), s),
    );
    const lines = out.split('\n');
    // Data line 1: ` ` (leading gutter) + `line1` (content padded to
    // width 5) + `+` (nl_right marker) + `|` + ` ` (col b leading
    // gutter) + `x` content. No padding / no trailing marker on the last
    // col when wrap state = none.
    expect(lines[2]).toBe(' line1+| x');
    // Data line 2: col a `line2` last line, right marker = ` ` (non-last
    // col, state=none); vrule; col b leading gutter ` `; past-end (no
    // content, no padding, no trailing marker).
    expect(lines[3]).toBe(' line2 | ');
  });

  test('wrapped mode emits `.` markers (wrap_left/right) on in-cell wrap', async () => {
    // Wrapped mode with a single cell wider than the column shrinks
    // emits `.` at end of one display line and start of the next.
    // Verified against vanilla psql 18 (`\pset format wrapped`).
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [['xxxxxxxxxx', 'y']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(
        rs,
        defaultOpts(undefined, {
          format: 'wrapped',
          border: 1,
          columns: 10,
          envColumns: 10,
        }),
        s,
      ),
    );
    // Column `a` shrinks to fit; the value wraps with `.` markers.
    expect(out).toMatch(/\.\| y/); // wrap_right (`.`) before separator
    expect(out).toMatch(/\n\./); // wrap_left (`.`) in leading gutter
  });

  test('border=0 last cell with continuation gets `+` at table edge (wrap_right_border)', async () => {
    // ASCII format has `wrap_right_border = true` so even at border=0
    // the trailing slot after the LAST column gets a marker (`+` for
    // nl_right / `.` for wrap_right / space otherwise). Verified against
    // vanilla psql 18 (`\pset border 0` on `SELECT 'a', E'line1\nline2'`).
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [['short', 'line1\nline2']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(rs, defaultOpts(undefined, { border: 0 }), s),
    );
    const lines = out.split('\n');
    // Header: both column widths = 5; `a` and `b` are centered in 5,
    // with a trailing ` ` marker (wrap_right_border).
    expect(lines[0]).toBe('  a     b   ');
    expect(lines[1]).toBe('----- -----');
    // Data line 1: col a (`short`) has no continuation → trailing ` `.
    // Col b (`line1`) DOES continue → trailing `+` (nl_right) at the
    // edge. No leading markers (border=0).
    expect(lines[2]).toBe('short line1+');
    // Data line 2: col a is past-end (empty). Upstream pads it because
    // `finalspaces` is true for non-last cols, then emits col a's right
    // marker as ` ` (state=none, not last). Col b's last line (`line2`)
    // has wrap state none, last col, border=0 → no trailing marker.
    // Result: 5 spaces (a padded) + space (a right marker) + `line2` = 11.
    expect(lines[3]).toBe('      line2');
  });

  test('border=0 first cell continuation puts `+` in cell-separator slot', async () => {
    // When the FIRST column has a `\n`-split cell, the trailing slot of
    // col a is the same as the (absent) column-divider position. Upstream
    // emits `nl_right` (`+`) right after col a's content. Verified
    // against vanilla psql 18.
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [['a\nb', 'y']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(rs, defaultOpts(undefined, { border: 0 }), s),
    );
    const lines = out.split('\n');
    // Data row 1: `a` + `+` (col a continuation marker) + `y` (col b, no
    // continuation). Last column at border=0 with state=NONE emits no
    // trailing marker — `a+y` ends bare.
    expect(lines[2]).toBe('a+y');
    // Data row 2: col a has `b` (last line, no continuation) so its
    // right marker is ` ` (non-last col emits space). Col b is past-end
    // (no `y` left); no padding (finalspaces=false for last col at
    // border=0) and no right marker. Result: `b` + ` ` + `` = `b `.
    expect(lines[3]).toBe('b ');
  });

  test('border=2 multi-line data row keeps right border aligned with `+` markers', async () => {
    // Border=2 has a full box, so the last column is padded AND the
    // right vrule appears after the marker. The `+` lands between
    // content and the right `|` rule on the row that continues, and
    // a space appears on the final row.
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }],
      rows: [['line1\nline2', 'y']],
    });
    const out = await capture((s) =>
      alignedPrinter.printQuery(rs, defaultOpts(undefined, { border: 2 }), s),
    );
    const lines = out.split('\n');
    // Data line 1: `line1` (5) + nl_right `+` + vrule + ` ` + `y` + ` `
    // (col b is not continuing) + vrule (right border).
    expect(lines[3]).toBe('| line1+| y |');
    // Data line 2: `line2` (5) + space (no continuation) + vrule +
    // empty col b padded to 1 + space + vrule.
    expect(lines[4]).toBe('| line2 |   |');
  });
});
