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

  describe('expanded mode (\\x on)', () => {
    test('renders Record blocks with c s + c | l body at border=1', async () => {
      const rs = makeResultSet({
        columns: [{ name: 'id', oid: 23 }, { name: 'name' }],
        rows: [
          [1, 'alice'],
          [2, 'bob'],
        ],
      });
      const out = await capture((s) =>
        troffMsPrinter.printQuery(
          rs,
          defaultOpts(undefined, { expanded: 'on' }),
          s,
        ),
      );
      expect(out).toBe(
        '.LP\n.TS\n' +
          'center;\n' +
          'c s.\n' +
          '\\fIRecord 1\\fP\n' +
          '_\n' +
          '.T&\n' +
          'c | l.\n' +
          'id\t1\n' +
          'name\talice\n' +
          '.T&\n' +
          'c s.\n' +
          '\\fIRecord 2\\fP\n' +
          '_\n' +
          '.T&\n' +
          'c | l.\n' +
          'id\t2\n' +
          'name\tbob\n' +
          '.TE\n.DS L\n.DE\n',
      );
    });

    test('expanded border=0 emits "c l." body spec and no _ separator', async () => {
      const rs = makeResultSet({
        columns: [{ name: 'a' }],
        rows: [['x']],
      });
      const out = await capture((s) =>
        troffMsPrinter.printQuery(
          rs,
          defaultOpts(undefined, { expanded: 'on', border: 0 }),
          s,
        ),
      );
      expect(out).toContain('c s.\n\\fIRecord 1\\fP\n.T&\nc l.\n');
      expect(out).not.toContain('_\n');
    });

    test('expanded border=2 emits "center box" plus inter-record _ separator', async () => {
      const rs = makeResultSet({
        columns: [{ name: 'a' }],
        rows: [['x'], ['y']],
      });
      const out = await capture((s) =>
        troffMsPrinter.printQuery(
          rs,
          defaultOpts(undefined, { expanded: 'on', border: 2 }),
          s,
        ),
      );
      expect(out).toContain('center box;\n');
      // Between record 1 and record 2 at border=2: _\n.T&\nc s.\n
      expect(out).toContain(
        'x\n_\n.T&\nc s.\n\\fIRecord 2\\fP\n_\n.T&\nc l.\n',
      );
    });

    test('expanded tuplesOnly uses one-shot "c l;" spec, no Record headers', async () => {
      const rs = makeResultSet({
        columns: [{ name: 'a' }, { name: 'b' }],
        rows: [
          ['x', 'y'],
          ['p', 'q'],
        ],
      });
      const out = await capture((s) =>
        troffMsPrinter.printQuery(
          rs,
          defaultOpts(undefined, { expanded: 'on', tuplesOnly: true }),
          s,
        ),
      );
      expect(out).toBe(
        '.LP\n.TS\n' +
          'center;\n' +
          'c l;\n' +
          '_\n' +
          'a\tx\n' +
          'b\ty\n' +
          '_\n' +
          'a\tp\n' +
          'b\tq\n' +
          '.TE\n.DS L\n.DE\n',
      );
    });

    test('expanded omits default (N rows) footer; preserves user footers', async () => {
      const rs = makeResultSet({
        columns: [{ name: 'a' }],
        rows: [['x']],
      });
      const out = await capture((s) =>
        troffMsPrinter.printQuery(
          rs,
          defaultOpts(undefined, { expanded: 'on' }),
          s,
        ),
      );
      expect(out).not.toContain('(1 row)');
      expect(out.endsWith('.TE\n.DS L\n.DE\n')).toBe(true);

      const withFooter = await capture((s) =>
        troffMsPrinter.printQuery(
          rs,
          defaultOpts({ footers: ['my note'] }, { expanded: 'on' }),
          s,
        ),
      );
      expect(withFooter).toContain('.TE\n.DS L\nmy note\n.DE\n');
    });

    test('expanded honors topt.prior for Record numbering', async () => {
      const rs = makeResultSet({
        columns: [{ name: 'a' }],
        rows: [['x'], ['y']],
      });
      const out = await capture((s) =>
        troffMsPrinter.printQuery(
          rs,
          defaultOpts(undefined, { expanded: 'on', prior: 9 }),
          s,
        ),
      );
      expect(out).toContain('\\fIRecord 10\\fP\n');
      expect(out).toContain('\\fIRecord 11\\fP\n');
    });

    test('expanded with title emits .DS C block', async () => {
      const rs = makeResultSet({
        columns: [{ name: 'a' }],
        rows: [['x']],
      });
      const out = await capture((s) =>
        troffMsPrinter.printQuery(
          rs,
          defaultOpts({ title: 'My Title' }, { expanded: 'on' }),
          s,
        ),
      );
      expect(out.startsWith('.LP\n.DS C\nMy Title\n.DE\n.LP\n.TS\n')).toBe(
        true,
      );
    });
  });
});
