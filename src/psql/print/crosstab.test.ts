/**
 * `pivotResultSet` / `printCrosstab` tests (WP-22).
 *
 * Two halves:
 *   1. `pivotResultSet` — pure transformation tests against various
 *      column-ref forms, sort directions, and error shapes.
 *   2. `printCrosstab` — drives the aligned printer end-to-end with a
 *      capturing stream and asserts rendered text.
 */

import { describe, expect, test } from 'vitest';

import type { FieldDescription, ResultSet } from '../types/connection.js';
import type { PrintQueryOpts, PrintTableOpts } from '../types/printer.js';

import { pivotResultSet, printCrosstab } from './crosstab.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    dataTypeID: c.oid ?? 25, // text by default
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

// ---------------------------------------------------------------------------
// pivotResultSet — basic pivot
// ---------------------------------------------------------------------------

describe('pivotResultSet basic', () => {
  test('three-column input pivots in first-appearance order', () => {
    // (V, H, D): three Vs (X, Y, Z), two Hs (A, B). Build a 3x2 matrix.
    const rs = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }, { name: 'd', oid: 23 }],
      rows: [
        ['X', 'A', 1],
        ['X', 'B', 2],
        ['Y', 'A', 3],
        ['Y', 'B', 4],
        ['Z', 'A', 5],
        ['Z', 'B', 6],
      ],
    });

    const r = pivotResultSet(rs, {});
    expect('error' in r).toBe(false);
    if ('error' in r) return;

    expect(r.rs.fields.map((f) => f.name)).toEqual(['v', 'A', 'B']);
    expect(r.rs.rows).toEqual([
      ['X', 1, 2],
      ['Y', 3, 4],
      ['Z', 5, 6],
    ]);
  });

  test('column references by name', () => {
    const rs = makeResultSet({
      columns: [{ name: 'row_name' }, { name: 'col_name' }, { name: 'val' }],
      rows: [
        ['r1', 'c1', 'aa'],
        ['r1', 'c2', 'bb'],
        ['r2', 'c1', 'cc'],
      ],
    });
    const r = pivotResultSet(rs, {
      colV: 'row_name',
      colH: 'col_name',
      colD: 'val',
    });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.rs.fields.map((f) => f.name)).toEqual(['row_name', 'c1', 'c2']);
    expect(r.rs.rows).toEqual([
      ['r1', 'aa', 'bb'],
      ['r2', 'cc', ''],
    ]);
  });

  test('column references by 1-based index', () => {
    const rs = makeResultSet({
      columns: [{ name: 'h' }, { name: 'd' }, { name: 'v' }],
      rows: [
        ['A', 11, 'X'],
        ['B', 22, 'X'],
        ['A', 33, 'Y'],
      ],
    });
    // V=3, H=1, D=2.
    const r = pivotResultSet(rs, { colV: 3, colH: 1, colD: 2 });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.rs.fields.map((f) => f.name)).toEqual(['v', 'A', 'B']);
    expect(r.rs.rows).toEqual([
      ['X', 11, 22],
      ['Y', 33, ''],
    ]);
  });

  test('unquoted name is downcased before strcmp', () => {
    // Upstream `indexOfColumn` dequote-downcases the user-supplied arg
    // and then exact-matches against PQfname. Unquoted `FOO` becomes
    // `foo`, which does NOT match a field named `Foo` — the test
    // `\crosstabview 1 2 Foo` in the regress corpus relies on this.
    const rs = makeResultSet({
      columns: [{ name: 'foo' }, { name: 'bar' }, { name: 'baz' }],
      rows: [['x', 'a', 1]],
    });
    const r = pivotResultSet(rs, {
      colV: 'FOO',
      colH: 'BAR',
      colD: 'Baz',
    });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.rs.fields.map((f) => f.name)).toEqual(['foo', 'a']);
  });

  test('unquoted name with capitalised field does not match', () => {
    const rs = makeResultSet({
      columns: [{ name: 'Foo' }, { name: 'bar' }, { name: 'baz' }],
      rows: [['x', 'a', 1]],
    });
    const r = pivotResultSet(rs, {
      colV: 'Foo', // downcased to "foo", field is "Foo" → no match
      colH: 'bar',
      colD: 'baz',
    });
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error).toMatch(/column name not found: "foo"/);
  });

  test('quoted name preserves case', () => {
    const rs = makeResultSet({
      columns: [{ name: 'Foo' }, { name: 'foo' }, { name: 'val' }],
      rows: [['rv', 'cv', 1]],
    });
    // Quoted "Foo" must match the capital-F field, not the lowercase one.
    const r = pivotResultSet(rs, {
      colV: '"Foo"',
      colH: '"foo"',
      colD: 'val',
    });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.rs.fields[0].name).toBe('Foo');
  });

  test('inherits colD data alignment via field oid', () => {
    const rs = makeResultSet({
      columns: [
        { name: 'v' },
        { name: 'h' },
        { name: 'd', oid: 23 }, // int4 → right-aligned
      ],
      rows: [['x', 'a', 1]],
    });
    const r = pivotResultSet(rs, {});
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    // The pivoted data columns should carry the colD oid so the aligned
    // printer's right-align heuristic kicks in.
    expect(r.rs.fields[1].dataTypeID).toBe(23);
  });
});

// ---------------------------------------------------------------------------
// pivotResultSet — sorting
// ---------------------------------------------------------------------------

describe('pivotResultSet sort', () => {
  test('without sortColH, column order is first-appearance', () => {
    const rs = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }, { name: 'd' }],
      rows: [
        ['x', 'B', 1],
        ['x', 'A', 2],
        ['x', 'C', 3],
      ],
    });
    const r = pivotResultSet(rs, {});
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.rs.fields.slice(1).map((f) => f.name)).toEqual(['B', 'A', 'C']);
  });

  test('sortColH numeric ascending', () => {
    const rs = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }, { name: 'd' }, { name: 'rank' }],
      rows: [
        ['x', 'mar', 1, '3'],
        ['x', 'feb', 2, '2'],
        ['x', 'jan', 3, '1'],
      ],
    });
    const r = pivotResultSet(rs, {
      colV: 'v',
      colH: 'h',
      colD: 'd',
      sortColH: 'rank',
    });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.rs.fields.slice(1).map((f) => f.name)).toEqual([
      'jan',
      'feb',
      'mar',
    ]);
  });

  test('sortColH numeric descending via leading "-"', () => {
    const rs = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }, { name: 'd' }, { name: 'rank' }],
      rows: [
        ['x', 'mar', 1, '3'],
        ['x', 'feb', 2, '2'],
        ['x', 'jan', 3, '1'],
      ],
    });
    const r = pivotResultSet(rs, {
      colV: 'v',
      colH: 'h',
      colD: 'd',
      sortColH: '-rank',
    });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.rs.fields.slice(1).map((f) => f.name)).toEqual([
      'mar',
      'feb',
      'jan',
    ]);
  });

  test('sortColH descending via negative number ref', () => {
    const rs = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }, { name: 'd' }, { name: 'rank' }],
      rows: [
        ['x', 'mar', 1, '3'],
        ['x', 'feb', 2, '2'],
        ['x', 'jan', 3, '1'],
      ],
    });
    const r = pivotResultSet(rs, {
      colV: 1,
      colH: 2,
      colD: 3,
      sortColH: -4,
    });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.rs.fields.slice(1).map((f) => f.name)).toEqual([
      'mar',
      'feb',
      'jan',
    ]);
  });

  test('sortColH alphabetic when non-numeric', () => {
    const rs = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }, { name: 'd' }, { name: 'sort' }],
      rows: [
        ['x', 'mar', 1, 'gamma'],
        ['x', 'feb', 2, 'alpha'],
        ['x', 'jan', 3, 'beta'],
      ],
    });
    const r = pivotResultSet(rs, {
      colV: 'v',
      colH: 'h',
      colD: 'd',
      sortColH: 'sort',
    });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.rs.fields.slice(1).map((f) => f.name)).toEqual([
      'feb',
      'jan',
      'mar',
    ]);
  });
});

// ---------------------------------------------------------------------------
// pivotResultSet — error cases
// ---------------------------------------------------------------------------

describe('pivotResultSet errors', () => {
  test('result with fewer than three columns errors', () => {
    // Upstream `crosstabview.c` requires `PQnfields >= 3` unconditionally
    // — a 1- or 2-column result has no payload to pivot. Both arities
    // surface the same diagnostic.
    const oneCol = makeResultSet({
      columns: [{ name: 'only' }],
      rows: [['x']],
    });
    let r = pivotResultSet(oneCol, {});
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error).toMatch(/at least three columns/);

    const twoCol = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }],
      rows: [['x', 'a']],
    });
    r = pivotResultSet(twoCol, {});
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error).toMatch(/at least three columns/);
  });

  test('more than three columns with no colD picks first non-V/H', () => {
    // Upstream `do_crosstabview` defaults `colD` to "first column that's
    // neither V nor H" even when the query returns >3 columns. This lets
    // `SELECT v,h,c,i \crosstabview` pivot `c` without an explicit arg
    // (the trailing `i` is ignored). We mirror that behaviour.
    const rs = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }, { name: 'd' }, { name: 'extra' }],
      rows: [['x', 'a', 1, 'z']],
    });
    const r = pivotResultSet(rs, {});
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    // Resulting field count: 1 (row header) + 1 (single H value) = 2.
    expect(r.rs.fields).toHaveLength(2);
    expect(r.rs.fields[1].name).toBe('a');
    expect(r.rs.rows[0]).toEqual(['x', 1]);
  });

  test('duplicate (colV, colH) pair errors', () => {
    const rs = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }, { name: 'd' }],
      rows: [
        ['x', 'a', 1],
        ['x', 'a', 2],
      ],
    });
    const r = pivotResultSet(rs, {});
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error).toMatch(/multiple data values/);
    expect(r.error).toContain('"x"');
    expect(r.error).toContain('"a"');
  });

  test('colV and colH being the same column errors', () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      rows: [['x', 'y', 1]],
    });
    const r = pivotResultSet(rs, { colV: 1, colH: 1, colD: 2 });
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error).toMatch(
      /vertical and horizontal headers must be different/,
    );
  });

  test('out-of-range column number errors', () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      rows: [['x', 'y', 1]],
    });
    const r = pivotResultSet(rs, { colV: 7 });
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error).toMatch(/out of range 1\.\.3/);
  });

  test('unknown column name errors', () => {
    const rs = makeResultSet({
      columns: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      rows: [['x', 'y', 1]],
    });
    const r = pivotResultSet(rs, { colV: 'nope' });
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error).toMatch(/column name not found/);
  });

  test('ambiguous column name errors', () => {
    const rs = makeResultSet({
      columns: [{ name: 'name' }, { name: 'name' }, { name: 'val' }],
      rows: [['x', 'y', 1]],
    });
    const r = pivotResultSet(rs, { colV: 'name' });
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error).toMatch(/ambiguous column name/);
  });
});

// ---------------------------------------------------------------------------
// pivotResultSet — null handling
// ---------------------------------------------------------------------------

describe('pivotResultSet nulls', () => {
  test('null colH value becomes a header column using nullPrint', () => {
    const rs = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }, { name: 'd' }],
      rows: [
        ['x', 'a', 1],
        ['x', null, 2],
      ],
    });
    // No nullPrint supplied → empty string (matches the default
    // `\pset null ''`).
    const rDefault = pivotResultSet(rs, {});
    expect('error' in rDefault).toBe(false);
    if ('error' in rDefault) return;
    expect(rDefault.rs.fields.map((f) => f.name)).toEqual(['v', 'a', '']);
    expect(rDefault.rs.rows[0]).toEqual(['x', 1, 2]);

    // Supplying a nullPrint (the active `\pset null` value) renders the
    // null H header inline at pivot time — matches the conformance
    // expectation that the column header reads `#null#` after
    // `\pset null '#null#'`.
    const rTagged = pivotResultSet(rs, {}, '#null#');
    expect('error' in rTagged).toBe(false);
    if ('error' in rTagged) return;
    expect(rTagged.rs.fields.map((f) => f.name)).toEqual(['v', 'a', '#null#']);
  });

  test('null colV value forms its own row', () => {
    const rs = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }, { name: 'd' }],
      rows: [
        ['x', 'a', 1],
        [null, 'a', 2],
      ],
    });
    const r = pivotResultSet(rs, {});
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.rs.rows.map((row) => row[0])).toEqual(['x', null]);
  });

  test('null cell values flow through and pick up nullPrint at print', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }, { name: 'd' }],
      rows: [
        ['x', 'a', null],
        ['x', 'b', 'yes'],
      ],
    });
    const out = await capture((stream) =>
      printCrosstab(
        rs,
        {},
        defaultOpts({ nullPrint: 'NIL' }, { nullPrint: 'NIL' }),
        stream,
      ).then(() => undefined),
    );
    // The 'a' column for row 'x' was explicitly null → renders as NIL.
    // The 'b' column renders as 'yes'.
    expect(out).toMatch(/NIL/);
    expect(out).toMatch(/yes/);
  });
});

// ---------------------------------------------------------------------------
// printCrosstab — render
// ---------------------------------------------------------------------------

describe('printCrosstab', () => {
  test('renders an aligned pivot table', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }, { name: 'd' }],
      rows: [
        ['x', 'a', '1'],
        ['x', 'b', '2'],
        ['y', 'a', '3'],
        ['y', 'b', '4'],
      ],
    });
    const out = await capture((stream) =>
      printCrosstab(rs, {}, defaultOpts(), stream).then(() => undefined),
    );
    // Expect a header row containing v, a, b and two data rows.
    expect(out).toContain('v');
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out).toMatch(/x\s+\|\s+1\s+\|\s+2/);
    expect(out).toMatch(/y\s+\|\s+3\s+\|\s+4/);
    expect(out).toMatch(/\(2 rows\)/);
  });

  test('returns error on duplicate without writing anything', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }, { name: 'd' }],
      rows: [
        ['x', 'a', 1],
        ['x', 'a', 2],
      ],
    });
    let wrote = '';
    const stream = {
      write(chunk: string): boolean {
        wrote += chunk;
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const err = await printCrosstab(rs, {}, defaultOpts(), stream);
    expect(err).not.toBeUndefined();
    expect(err?.error).toMatch(/multiple data values/);
    expect(wrote).toBe('');
  });

  test('passes nullPrint through to cells', async () => {
    const rs = makeResultSet({
      columns: [{ name: 'v' }, { name: 'h' }, { name: 'd' }],
      rows: [
        ['x', 'a', null],
        ['x', 'b', 1],
      ],
    });
    const out = await capture((stream) =>
      printCrosstab(
        rs,
        {},
        defaultOpts({ nullPrint: '<NULL>' }, { nullPrint: '<NULL>' }),
        stream,
      ).then(() => undefined),
    );
    expect(out).toContain('<NULL>');
  });
});
