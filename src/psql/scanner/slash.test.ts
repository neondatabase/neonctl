import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { BACKTICK_EXECUTOR, scanSlashArgs } from './slash.js';

const lookup =
  (vars: Record<string, string>) =>
  (name: string): string | undefined =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;

// stderr capture for the backtick error path.
let stderrChunks: string[];
let stderrOrig: typeof process.stderr.write;

beforeEach(() => {
  stderrChunks = [];
  stderrOrig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = stderrOrig;
  // Reset the executor to its original implementation so test ordering
  // can't leave a stale mock in place.
  BACKTICK_EXECUTOR.current = ORIG_EXECUTOR;
});

const ORIG_EXECUTOR = BACKTICK_EXECUTOR.current;
const stderr = (): string => stderrChunks.join('');

describe('scanSlashArgs — bare args', () => {
  test('splits whitespace-separated bare args', () => {
    expect(scanSlashArgs(' foo bar baz', 'normal')).toEqual([
      'foo',
      'bar',
      'baz',
    ]);
  });

  test('empty input returns []', () => {
    expect(scanSlashArgs('', 'normal')).toEqual([]);
  });

  test('whitespace-only input returns []', () => {
    expect(scanSlashArgs('   \t\n', 'normal')).toEqual([]);
  });

  test('trailing whitespace is tolerated', () => {
    expect(scanSlashArgs('foo  ', 'normal')).toEqual(['foo']);
  });

  test('stops at the next backslash command', () => {
    expect(scanSlashArgs('foo bar \\next', 'normal')).toEqual(['foo', 'bar']);
  });
});

describe('scanSlashArgs — single-quoted args', () => {
  test('keeps spaces inside single quotes', () => {
    expect(scanSlashArgs("'hello world'", 'normal')).toEqual(['hello world']);
  });

  test('escape produces literal quote inside the arg', () => {
    expect(scanSlashArgs("'a\\'b'", 'normal')).toEqual(["a'b"]);
  });

  test('doubled quotes become a single literal quote', () => {
    expect(scanSlashArgs("'it''s'", 'normal')).toEqual(["it's"]);
  });

  test('C-style escapes are decoded', () => {
    expect(scanSlashArgs("'a\\tb\\nC'", 'normal')).toEqual(['a\tb\nC']);
  });

  test('octal and hex escapes', () => {
    expect(scanSlashArgs("'\\101 \\x41'", 'normal')).toEqual(['A A']);
  });

  test('adjacent single-quoted runs concatenate', () => {
    expect(scanSlashArgs("'foo''bar'", 'normal')).toEqual(["foo'bar"]);
  });
});

describe('scanSlashArgs — double-quoted args (sql-id modes)', () => {
  test('double quotes survive lexing as part of the arg in normal mode', () => {
    // In normal mode, dquotes are kept verbatim (upstream xslashdquote ECHO).
    expect(scanSlashArgs('"FooBar"', 'normal')).toEqual(['"FooBar"']);
  });

  test('sql-id downcases unquoted letters and strips quotes', () => {
    expect(scanSlashArgs('MySchema."MyTable"', 'sql-id')).toEqual([
      'myschema.MyTable',
    ]);
  });

  test('sql-id-keep-case preserves outer letters', () => {
    expect(scanSlashArgs('MySchema."MyTable"', 'sql-id-keep-case')).toEqual([
      'MySchema.MyTable',
    ]);
  });

  test('embedded "" collapses to a single quote', () => {
    expect(scanSlashArgs('"weird""name"', 'sql-id')).toEqual(['weird"name']);
  });
});

describe('scanSlashArgs — variable substitution', () => {
  test(':name expands to value', () => {
    const vars = lookup({ NAME: 'world' });
    expect(scanSlashArgs('hello :NAME', 'normal', vars)).toEqual([
      'hello',
      'world',
    ]);
  });

  test('unset variable is left as literal :name', () => {
    expect(scanSlashArgs('hello :MISSING', 'normal', lookup({}))).toEqual([
      'hello',
      ':MISSING',
    ]);
  });

  test(":'name' produces a SQL literal", () => {
    const vars = lookup({ val: "it's" });
    expect(scanSlashArgs(":'val'", 'normal', vars)).toEqual(["'it''s'"]);
  });

  test(':"name" produces a SQL identifier', () => {
    const vars = lookup({ tbl: 'My"Table' });
    expect(scanSlashArgs(':"tbl"', 'normal', vars)).toEqual(['"My""Table"']);
  });

  test('no-vars mode disables substitution', () => {
    const vars = lookup({ NAME: 'world' });
    expect(scanSlashArgs(':NAME', 'no-vars', vars)).toEqual([':NAME']);
  });

  test('var substitution inside concatenation', () => {
    // Variable names are greedy ([A-Za-z0-9_]+ — upstream `variable_char`),
    // so `pre:Xpost` resolves the name as `Xpost`, not `X`. To insert a
    // value mid-token the caller must terminate the name with quotes.
    const vars = lookup({ X: 'mid' });
    expect(scanSlashArgs("pre:X''post", 'normal', vars)).toEqual([
      'premidpost',
    ]);
  });
});

describe('scanSlashArgs — filepipe mode', () => {
  test('plain filename behaves like normal', () => {
    expect(scanSlashArgs('out.txt', 'filepipe')).toEqual(['out.txt']);
  });

  test('leading | flips to whole-rest-of-line', () => {
    expect(scanSlashArgs('|less -R', 'filepipe')).toEqual(['|less -R']);
  });

  test('| further into the input is not special', () => {
    expect(scanSlashArgs('foo |less', 'filepipe')).toEqual(['foo', '|less']);
  });
});

describe('scanSlashArgs — whole-line mode', () => {
  test('returns the entire rest of the line as a single arg', () => {
    expect(scanSlashArgs('SELECT 1; SELECT 2;', 'whole-line')).toEqual([
      'SELECT 1; SELECT 2;',
    ]);
  });

  test('strips leading whitespace', () => {
    expect(scanSlashArgs('   echo hi', 'whole-line')).toEqual(['echo hi']);
  });

  test('empty / whitespace-only input yields []', () => {
    expect(scanSlashArgs('', 'whole-line')).toEqual([]);
    expect(scanSlashArgs('   \t', 'whole-line')).toEqual([]);
  });
});

describe('scanSlashArgs — backticks', () => {
  test('backticked command substitutes its stdout (newline trimmed)', () => {
    const exec = vi.fn(() => 'hi\n');
    BACKTICK_EXECUTOR.current = exec;
    expect(scanSlashArgs('`echo hi`', 'normal')).toEqual(['hi']);
    expect(exec).toHaveBeenCalledWith('echo hi');
  });

  test(':var inside backticks expands before exec', () => {
    const calls: string[] = [];
    BACKTICK_EXECUTOR.current = (cmd: string) => {
      calls.push(cmd);
      return 'mock\n';
    };
    const vars = lookup({ CMD: 'date' });
    expect(scanSlashArgs('`:CMD -u`', 'normal', vars)).toEqual(['mock']);
    expect(calls).toEqual(['date -u']);
  });

  test('backtick output concatenates with surrounding literal text', () => {
    BACKTICK_EXECUTOR.current = () => '42';
    expect(scanSlashArgs('pre`x`post', 'normal')).toEqual(['pre42post']);
  });

  test('multi-line output preserves interior newlines, trims one trailing', () => {
    BACKTICK_EXECUTOR.current = () => 'a\nb\nc\n';
    expect(scanSlashArgs('`x`', 'normal')).toEqual(['a\nb\nc']);
  });

  test('failed command logs to stderr and substitutes empty string', () => {
    BACKTICK_EXECUTOR.current = () => {
      throw new Error('command failed');
    };
    expect(scanSlashArgs('`bogus`', 'normal')).toEqual(['']);
    expect(stderr()).toMatch(/psql: error: \\!: bogus: command failed/);
  });

  test('empty backticks (``) are a no-op empty string', () => {
    const exec = vi.fn(() => 'should-not-run');
    BACKTICK_EXECUTOR.current = exec;
    expect(scanSlashArgs('``', 'normal')).toEqual(['']);
    expect(exec).not.toHaveBeenCalled();
  });

  test('real execSync round-trip via /bin/echo', () => {
    // Smoke test the un-mocked path; uses the original executor.
    BACKTICK_EXECUTOR.current = ORIG_EXECUTOR;
    expect(scanSlashArgs('`echo hello`', 'normal')).toEqual(['hello']);
  });
});
