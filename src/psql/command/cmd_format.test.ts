import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { BackslashContext, BackslashCmdSpec } from '../types/backslash.js';
import type { PsqlSettings } from '../types/settings.js';
import { createVarStore } from '../core/variables.js';
import { defaultSettings } from '../core/settings.js';

import {
  cmdA,
  cmdC,
  cmdEncoding,
  cmdF,
  cmdH,
  cmdPset,
  cmdT,
  cmdTitleAttr,
  cmdX,
} from './cmd_format.js';

// Mock context factory — naive whitespace tokenization with single-quote
// support. Sufficient for the formatting-command suite, none of which
// exercise complex quoting.
const makeMockCtx = (
  cmdName: string,
  rawArgs: string,
  settings?: PsqlSettings,
): BackslashContext => {
  const s = settings ?? defaultSettings(createVarStore());
  let cursor = 0;
  return {
    settings: s,
    cmdName,
    queryBuf: '',
    rawArgs,
    nextArg: () => {
      while (cursor < rawArgs.length && /\s/.test(rawArgs[cursor])) cursor++;
      if (cursor >= rawArgs.length) return null;
      if (rawArgs[cursor] === "'") {
        cursor++;
        let out = '';
        while (cursor < rawArgs.length && rawArgs[cursor] !== "'") {
          out += rawArgs[cursor++];
        }
        if (cursor < rawArgs.length) cursor++;
        return out;
      }
      const start = cursor;
      while (cursor < rawArgs.length && !/\s/.test(rawArgs[cursor])) cursor++;
      return rawArgs.slice(start, cursor);
    },
    restOfLine: () => {
      while (cursor < rawArgs.length && /\s/.test(rawArgs[cursor])) cursor++;
      const tail = rawArgs.slice(cursor);
      cursor = rawArgs.length;
      return tail;
    },
  };
};

let stdoutChunks: string[];
let stderrChunks: string[];
let stdoutOrig: typeof process.stdout.write;
let stderrOrig: typeof process.stderr.write;

beforeEach(() => {
  stdoutChunks = [];
  stderrChunks = [];
  stdoutOrig = process.stdout.write.bind(process.stdout);
  stderrOrig = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = stdoutOrig;
  process.stderr.write = stderrOrig;
});

const stdout = (): string => stdoutChunks.join('');
const stderr = (): string => stderrChunks.join('');
const run = (spec: BackslashCmdSpec, ctx: BackslashContext) => spec.run(ctx);

describe('\\a', () => {
  test('toggles aligned ↔ unaligned', async () => {
    const settings = defaultSettings(createVarStore());
    expect(settings.popt.topt.format).toBe('aligned');
    await run(cmdA, makeMockCtx('a', '', settings));
    expect(settings.popt.topt.format).toBe('unaligned');
    await run(cmdA, makeMockCtx('a', '', settings));
    expect(settings.popt.topt.format).toBe('aligned');
  });
});

describe('\\C', () => {
  test('sets and clears title', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdC, makeMockCtx('C', "'my title'", settings));
    expect(settings.popt.topt.title).toBe('my title');
    await run(cmdC, makeMockCtx('C', '', settings));
    expect(settings.popt.topt.title).toBeNull();
  });
});

describe('\\f', () => {
  test('sets and shows field separator', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdF, makeMockCtx('f', ',', settings));
    expect(settings.popt.topt.fieldSep).toBe(',');
    await run(cmdF, makeMockCtx('f', '', settings));
    expect(stdout()).toMatch(/Field separator is ","/);
  });
});

describe('\\H', () => {
  test('toggles html ↔ aligned', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdH, makeMockCtx('H', '', settings));
    expect(settings.popt.topt.format).toBe('html');
    await run(cmdH, makeMockCtx('H', '', settings));
    expect(settings.popt.topt.format).toBe('aligned');
  });
});

describe('\\t', () => {
  test('toggles tuples_only with no arg', async () => {
    const settings = defaultSettings(createVarStore());
    expect(settings.popt.topt.tuplesOnly).toBe(false);
    await run(cmdT, makeMockCtx('t', '', settings));
    expect(settings.popt.topt.tuplesOnly).toBe(true);
    expect(stdout()).toMatch(/Tuples only is on\./);
  });

  test('explicit on / off', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdT, makeMockCtx('t', 'on', settings));
    expect(settings.popt.topt.tuplesOnly).toBe(true);
    await run(cmdT, makeMockCtx('t', 'off', settings));
    expect(settings.popt.topt.tuplesOnly).toBe(false);
  });

  test('unknown value errors', async () => {
    const r = await run(cmdT, makeMockCtx('t', 'maybe'));
    expect(r.status).toBe('error');
    expect(stderr()).toMatch(/unrecognized value/);
  });
});

describe('\\T', () => {
  test('sets and clears table attr', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdTitleAttr, makeMockCtx('T', "'border=1'", settings));
    expect(settings.popt.topt.tableAttr).toBe('border=1');
    await run(cmdTitleAttr, makeMockCtx('T', '', settings));
    expect(settings.popt.topt.tableAttr).toBeNull();
  });
});

describe('\\x', () => {
  test('toggles expanded', async () => {
    const settings = defaultSettings(createVarStore());
    expect(settings.popt.topt.expanded).toBe('off');
    await run(cmdX, makeMockCtx('x', '', settings));
    expect(settings.popt.topt.expanded).toBe('on');
    expect(stdout()).toMatch(/Expanded display is on\./);
  });

  test('explicit auto', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdX, makeMockCtx('x', 'auto', settings));
    expect(settings.popt.topt.expanded).toBe('auto');
  });

  test('invalid value errors', async () => {
    const r = await run(cmdX, makeMockCtx('x', 'foo'));
    expect(r.status).toBe('error');
  });
});

describe('\\encoding', () => {
  test('shows current encoding when no arg', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdEncoding, makeMockCtx('encoding', '', settings));
    expect(stdout().trim()).toBe(settings.popt.topt.encoding);
  });

  test('sets encoding', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdEncoding, makeMockCtx('encoding', 'LATIN1', settings));
    expect(settings.popt.topt.encoding).toBe('LATIN1');
  });
});

describe('\\pset format', () => {
  test.each([
    'aligned',
    'unaligned',
    'wrapped',
    'html',
    'asciidoc',
    'latex',
    'latex-longtable',
    'troff-ms',
    'csv',
    'json',
  ])('accepts %s', async (fmt) => {
    const settings = defaultSettings(createVarStore());
    await run(cmdPset, makeMockCtx('pset', `format ${fmt}`, settings));
    expect(settings.popt.topt.format).toBe(fmt);
    expect(stdout()).toMatch(
      new RegExp(`Output format is ${fmt.replace(/[-]/g, '\\-')}\\.`),
    );
  });

  test('rejects unknown format', async () => {
    const r = await run(cmdPset, makeMockCtx('pset', 'format weird'));
    expect(r.status).toBe('error');
  });
});

describe('\\pset border', () => {
  test.each([0, 1, 2, 3])('accepts %d', async (n) => {
    const settings = defaultSettings(createVarStore());
    await run(cmdPset, makeMockCtx('pset', `border ${n}`, settings));
    expect(settings.popt.topt.border).toBe(n);
  });

  test('rejects out-of-range', async () => {
    const r = await run(cmdPset, makeMockCtx('pset', 'border 9'));
    expect(r.status).toBe('error');
  });
});

describe('\\pset pager', () => {
  test.each(['off', 'on', 'always'])('accepts %s', async (val) => {
    const settings = defaultSettings(createVarStore());
    await run(cmdPset, makeMockCtx('pset', `pager ${val}`, settings));
    expect(settings.popt.topt.pager).toBe(val);
  });
});

describe('\\pset null', () => {
  test('sets nullPrint', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdPset, makeMockCtx('pset', "null 'NULL'", settings));
    expect(settings.popt.topt.nullPrint).toBe('NULL');
  });
});

describe('\\pset misc', () => {
  test('expanded toggle', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdPset, makeMockCtx('pset', 'expanded on', settings));
    expect(settings.popt.topt.expanded).toBe('on');
  });

  test('tuples_only', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdPset, makeMockCtx('pset', 'tuples_only on', settings));
    expect(settings.popt.topt.tuplesOnly).toBe(true);
  });

  test('title', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdPset, makeMockCtx('pset', "title 'hello'", settings));
    expect(settings.popt.topt.title).toBe('hello');
  });

  test('fieldsep_zero', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdPset, makeMockCtx('pset', 'fieldsep_zero', settings));
    expect(settings.popt.topt.fieldSep).toBe('\0');
  });

  test('recordsep_zero', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdPset, makeMockCtx('pset', 'recordsep_zero', settings));
    expect(settings.popt.topt.recordSep).toBe('\0');
  });

  test('csv_fieldsep accepts single char', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdPset, makeMockCtx('pset', 'csv_fieldsep ;', settings));
    expect(settings.popt.topt.csvFieldSep).toBe(';');
  });

  test('csv_fieldsep rejects multi-char', async () => {
    const r = await run(cmdPset, makeMockCtx('pset', 'csv_fieldsep ab'));
    expect(r.status).toBe('error');
  });

  test('linestyle accepts unicode', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdPset, makeMockCtx('pset', 'linestyle unicode', settings));
    expect(settings.popt.topt.unicodeBorderLineStyle).toBe('unicode');
  });

  test('columns sets a positive int', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdPset, makeMockCtx('pset', 'columns 100', settings));
    expect(settings.popt.topt.columns).toBe(100);
  });

  test('unknown option errors', async () => {
    const r = await run(cmdPset, makeMockCtx('pset', 'mystery x'));
    expect(r.status).toBe('error');
  });

  test('no args prints all options', async () => {
    await run(cmdPset, makeMockCtx('pset', ''));
    const out = stdout();
    expect(out).toMatch(/border /);
    expect(out).toMatch(/format /);
    expect(out).toMatch(/expanded /);
  });

  test('no args emits every upstream-parity setting', async () => {
    // Mirrors vanilla psql 18's `\pset` bulk view (alphabetical, 25-col
    // gutter). The exact wording is regression-checked in
    // tests/psql-conformance/regress.spec.ts:psql.out — this test guards
    // the unit-level shape so a refactor doesn't silently drop entries.
    await run(cmdPset, makeMockCtx('pset', ''));
    const out = stdout();
    expect(out).toContain('border                   1\n');
    expect(out).toContain('columns                  0\n');
    expect(out).toContain("csv_fieldsep             ','\n");
    expect(out).toContain('expanded                 off\n');
    expect(out).toContain("fieldsep                 '|'\n");
    expect(out).toContain('fieldsep_zero            off\n');
    expect(out).toContain('footer                   on\n');
    expect(out).toContain('format                   aligned\n');
    expect(out).toContain('linestyle                ascii\n');
    expect(out).toContain("null                     ''\n");
    expect(out).toContain('numericlocale            off\n');
    expect(out).toContain('pager                    1\n');
    expect(out).toContain('pager_min_lines          0\n');
    expect(out).toContain("recordsep                '\\n'\n");
    expect(out).toContain('recordsep_zero           off\n');
    expect(out).toContain('tableattr                \n');
    expect(out).toContain('title                    \n');
    expect(out).toContain('tuples_only              off\n');
    expect(out).toContain('unicode_border_linestyle single\n');
    expect(out).toContain('unicode_column_linestyle single\n');
    expect(out).toContain('unicode_header_linestyle single\n');
    expect(out).toContain('xheader_width            full\n');
  });

  test('fieldsep_zero / recordsep_zero are derived from sep value', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdPset, makeMockCtx('pset', 'fieldsep_zero', settings));
    await run(cmdPset, makeMockCtx('pset', 'recordsep_zero', settings));
    await run(cmdPset, makeMockCtx('pset', '', settings));
    const out = stdout();
    expect(out).toContain('fieldsep_zero            on\n');
    expect(out).toContain('recordsep_zero           on\n');
  });

  test('pager bulk-show uses numeric encoding (0=off / 1=on / 2=always)', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdPset, makeMockCtx('pset', 'pager off', settings));
    await run(cmdPset, makeMockCtx('pset', '', settings));
    expect(stdout()).toMatch(/pager\s+0\n/);

    stdoutChunks.length = 0;
    await run(cmdPset, makeMockCtx('pset', 'pager always', settings));
    await run(cmdPset, makeMockCtx('pset', '', settings));
    expect(stdout()).toMatch(/pager\s+2\n/);
  });

  test('footer toggles defaultFooter and rejects non-boolean', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdPset, makeMockCtx('pset', 'footer off', settings));
    expect(settings.popt.topt.defaultFooter).toBe(false);
    await run(cmdPset, makeMockCtx('pset', 'footer on', settings));
    expect(settings.popt.topt.defaultFooter).toBe(true);
    // toggle via no-arg
    await run(cmdPset, makeMockCtx('pset', 'footer', settings));
    expect(settings.popt.topt.defaultFooter).toBe(false);
    const r = await run(cmdPset, makeMockCtx('pset', 'footer maybe', settings));
    expect(r.status).toBe('error');
  });

  test('unicode_*_linestyle stores single/double independently', async () => {
    const settings = defaultSettings(createVarStore());
    await run(
      cmdPset,
      makeMockCtx('pset', 'unicode_border_linestyle double', settings),
    );
    expect(settings.popt.topt.unicodeBorderStyle).toBe('double');
    expect(settings.popt.topt.unicodeColumnStyle).toBe('single');
    expect(settings.popt.topt.unicodeHeaderStyle).toBe('single');
  });

  test('xheader_width accepts full/column/page and positive int', async () => {
    const settings = defaultSettings(createVarStore());
    await run(cmdPset, makeMockCtx('pset', 'xheader_width column', settings));
    expect(settings.popt.topt.xheaderWidth).toBe('column');
    await run(cmdPset, makeMockCtx('pset', 'xheader_width 42', settings));
    expect(settings.popt.topt.xheaderWidth).toBe(42);
    await run(cmdPset, makeMockCtx('pset', 'xheader_width full', settings));
    expect(settings.popt.topt.xheaderWidth).toBe('full');
    const r = await run(
      cmdPset,
      makeMockCtx('pset', 'xheader_width -5', settings),
    );
    expect(r.status).toBe('error');
  });
});
