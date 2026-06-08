import { describe, it, expect } from 'vitest';

import {
  HeadMatches,
  MatchAny,
  MatchAnyExcept,
  Matches,
  TailMatches,
  splitForCompletion,
  tokenize,
  wordMatches,
} from './matcher.js';

describe('wordMatches', () => {
  it('returns true for null pattern (MatchAny)', () => {
    expect(wordMatches(null, 'anything')).toBe(true);
    expect(wordMatches(MatchAny, 'anything')).toBe(true);
  });

  it('matches case-insensitively by default', () => {
    expect(wordMatches('SELECT', 'select')).toBe(true);
    expect(wordMatches('select', 'SELECT')).toBe(true);
    expect(wordMatches('SELECT', 'Select')).toBe(true);
  });

  it('respects caseSensitive flag', () => {
    expect(wordMatches('SELECT', 'select', true)).toBe(false);
    expect(wordMatches('SELECT', 'SELECT', true)).toBe(true);
  });

  it('handles alternation with |', () => {
    expect(wordMatches('TABLE|VIEW', 'TABLE')).toBe(true);
    expect(wordMatches('TABLE|VIEW', 'VIEW')).toBe(true);
    expect(wordMatches('TABLE|VIEW', 'INDEX')).toBe(false);
  });

  it('handles single-word wildcard with *', () => {
    expect(wordMatches('pg_*', 'pg_class')).toBe(true);
    expect(wordMatches('*_table', 'my_table')).toBe(true);
    expect(wordMatches('pg_*_class', 'pg_extra_class')).toBe(true);
    expect(wordMatches('pg_*', 'something')).toBe(false);
  });

  it('handles negation with !', () => {
    expect(wordMatches('!SELECT', 'INSERT')).toBe(true);
    expect(wordMatches('!SELECT', 'SELECT')).toBe(false);
    expect(wordMatches(MatchAnyExcept('SELECT'), 'INSERT')).toBe(true);
    expect(wordMatches(MatchAnyExcept('SELECT'), 'SELECT')).toBe(false);
  });
});

describe('Matches', () => {
  it('requires exact length match', () => {
    expect(Matches(['SELECT'], ['SELECT'])).toBe(true);
    expect(Matches(['SELECT', 'a'], ['SELECT'])).toBe(false);
    expect(Matches(['SELECT'], ['SELECT', 'FROM'])).toBe(false);
  });

  it('matches each word against its pattern', () => {
    expect(Matches(['SELECT', 'x', 'FROM'], ['SELECT', MatchAny, 'FROM'])).toBe(
      true,
    );
    expect(
      Matches(['SELECT', 'x', 'WHERE'], ['SELECT', MatchAny, 'FROM']),
    ).toBe(false);
  });

  it('returns true for empty arrays', () => {
    expect(Matches([], [])).toBe(true);
  });
});

describe('TailMatches', () => {
  it('matches when the last N words match', () => {
    expect(TailMatches(['SELECT', 'x', 'FROM'], ['FROM'])).toBe(true);
    expect(TailMatches(['SELECT', 'x', 'FROM'], ['x', 'FROM'])).toBe(true);
    expect(
      TailMatches(['SELECT', 'x', 'FROM'], ['SELECT', MatchAny, 'FROM']),
    ).toBe(true);
  });

  it('returns false when prev is shorter than pattern', () => {
    expect(TailMatches(['FROM'], ['SELECT', 'FROM'])).toBe(false);
  });

  it('returns false when tail does not match', () => {
    expect(TailMatches(['SELECT', 'x', 'WHERE'], ['FROM'])).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(TailMatches(['from'], ['FROM'])).toBe(true);
  });
});

describe('HeadMatches', () => {
  it('matches when the first N words match', () => {
    expect(HeadMatches(['ALTER', 'TABLE', 'foo'], ['ALTER', 'TABLE'])).toBe(
      true,
    );
    expect(HeadMatches(['ALTER', 'TABLE', 'foo'], ['ALTER'])).toBe(true);
  });

  it('returns false when prev is shorter than pattern', () => {
    expect(HeadMatches(['ALTER'], ['ALTER', 'TABLE'])).toBe(false);
  });

  it('returns false when head does not match', () => {
    expect(HeadMatches(['DROP', 'TABLE'], ['ALTER', 'TABLE'])).toBe(false);
  });
});

describe('tokenize', () => {
  it('splits on whitespace', () => {
    const t = tokenize('select foo bar');
    expect(t.map((x) => x.text)).toEqual(['select', 'foo', 'bar']);
  });

  it('preserves double-quoted identifiers as one token', () => {
    const t = tokenize('SELECT * FROM "my table"');
    expect(t.map((x) => x.text)).toEqual(['SELECT', '*', 'FROM', '"my table"']);
  });

  it('preserves single-quoted string literals as one token', () => {
    const t = tokenize("WHERE x = 'hello world'");
    expect(t.map((x) => x.text)).toEqual(['WHERE', 'x', '=', "'hello world'"]);
  });

  it('captures backslash commands as a single token', () => {
    const t = tokenize('\\dt mytable');
    expect(t.map((x) => x.text)).toEqual(['\\dt', 'mytable']);
  });

  it('captures \\? and \\! as a single token', () => {
    expect(tokenize('\\?').map((x) => x.text)).toEqual(['\\?']);
    expect(tokenize('\\!').map((x) => x.text)).toEqual(['\\!']);
  });

  it('folds a trailing `+` suffix into the backslash word', () => {
    // `\dt+ foo` must tokenize as ['\\dt+', 'foo'] — not ['\\dt', '+', 'foo'] —
    // so describe completion rules that key on `prevWords.length === 1` fire.
    expect(tokenize('\\dt+ mytable').map((x) => x.text)).toEqual([
      '\\dt+',
      'mytable',
    ]);
    // The `S` (system) suffix is a letter, so `\dtS+` stays one token too.
    expect(tokenize('\\dtS+ foo').map((x) => x.text)).toEqual([
      '\\dtS+',
      'foo',
    ]);
  });

  it('separates punctuation', () => {
    const t = tokenize('SELECT a, b FROM x;');
    expect(t.map((x) => x.text)).toEqual([
      'SELECT',
      'a',
      ',',
      'b',
      'FROM',
      'x',
      ';',
    ]);
  });

  it('keeps schema-qualified identifiers as one token', () => {
    const t = tokenize('SELECT * FROM pg_catalog.pg_class');
    expect(t.map((x) => x.text)).toEqual([
      'SELECT',
      '*',
      'FROM',
      'pg_catalog.pg_class',
    ]);
  });

  it('handles empty input', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('splitForCompletion', () => {
  it('treats trailing whitespace as starting a new word', () => {
    const r = splitForCompletion('SELECT ', 7);
    expect(r.prevWords).toEqual(['SELECT']);
    expect(r.currentWord).toBe('');
    expect(r.replaceLength).toBe(0);
  });

  it('captures the in-progress word', () => {
    const r = splitForCompletion('SEL', 3);
    expect(r.prevWords).toEqual([]);
    expect(r.currentWord).toBe('SEL');
    expect(r.replaceLength).toBe(3);
  });

  it('keeps prev words and current word separate', () => {
    const r = splitForCompletion('SELECT * FROM pg_c', 18);
    expect(r.prevWords).toEqual(['SELECT', '*', 'FROM']);
    expect(r.currentWord).toBe('pg_c');
    expect(r.replaceLength).toBe(4);
  });

  it('handles backslash commands without args', () => {
    const r = splitForCompletion('\\d', 2);
    expect(r.prevWords).toEqual([]);
    expect(r.currentWord).toBe('\\d');
    expect(r.replaceLength).toBe(2);
  });

  it('handles backslash command + arg-in-progress', () => {
    const r = splitForCompletion('\\dt my_', 7);
    expect(r.prevWords).toEqual(['\\dt']);
    expect(r.currentWord).toBe('my_');
    expect(r.replaceLength).toBe(3);
  });

  it('keeps a `+`-suffixed backslash command as the only prev word', () => {
    const r = splitForCompletion('\\dt+ my_', 8);
    expect(r.prevWords).toEqual(['\\dt+']);
    expect(r.currentWord).toBe('my_');
    expect(r.replaceLength).toBe(3);
  });

  it('returns empty for empty input', () => {
    const r = splitForCompletion('', 0);
    expect(r.prevWords).toEqual([]);
    expect(r.currentWord).toBe('');
    expect(r.replaceLength).toBe(0);
  });

  it('only considers input up to cursor', () => {
    const r = splitForCompletion('SELECT * FROM pg_class', 14);
    // Cursor sits after 'FROM ' with a leading char.
    expect(r.prevWords).toEqual(['SELECT', '*', 'FROM']);
    expect(r.currentWord).toBe('');
  });
});
