import { describe, expect, test } from 'vitest';

import { scanSlashArgs } from './slash.js';

const lookup =
  (vars: Record<string, string>) =>
  (name: string): string | undefined =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;

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

describe('scanSlashArgs — backticks (stubbed)', () => {
  test('backticked text is passed through verbatim', () => {
    // WP-12 will wire shell exec; for now we keep the backticks visible.
    expect(scanSlashArgs('`echo hi`', 'normal')).toEqual(['`echo hi`']);
  });

  test(':var inside backticks still expands', () => {
    const vars = lookup({ CMD: 'date' });
    expect(scanSlashArgs('`:CMD -u`', 'normal', vars)).toEqual(['`date -u`']);
  });
});
