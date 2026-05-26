import { describe, expect, test } from 'vitest';

import {
  dequote,
  quoteIfNeeded,
  quoteSqlIdent,
  quoteSqlLiteral,
  strtokx,
  tryConsumeVarSubstitution,
} from './stringutils.js';

const WS = ' \t\n';
const DELIM = ',;';
const QUOTE = '\'"';

describe('strtokx — bare tokens', () => {
  test('splits on whitespace', () => {
    let rest = 'foo bar baz';
    const seen: string[] = [];
    for (;;) {
      const r = strtokx(rest, WS, DELIM, QUOTE, '\\', null, false);
      if (r.token === null) break;
      seen.push(r.token);
      rest = r.rest;
    }
    expect(seen).toEqual(['foo', 'bar', 'baz']);
  });

  test('empty input returns null', () => {
    expect(strtokx('', WS, DELIM, QUOTE, '\\', null, false).token).toBeNull();
  });

  test('whitespace-only input returns null', () => {
    expect(
      strtokx('   \t\n', WS, DELIM, QUOTE, '\\', null, false).token,
    ).toBeNull();
  });

  test('skips leading whitespace', () => {
    const r = strtokx('   hello', WS, DELIM, QUOTE, '\\', null, false);
    expect(r.token).toBe('hello');
    expect(r.rest).toBe('');
  });
});

describe('strtokx — delim tokens', () => {
  test('delimiter is emitted as its own single-char token (atEol=true)', () => {
    // With atEol=true the trailing delim is left for the next call, so it
    // surfaces as its own token (matching upstream's `strtokx()` contract).
    let rest = 'a,b';
    const seen: string[] = [];
    for (;;) {
      const r = strtokx(rest, WS, DELIM, QUOTE, '\\', null, true);
      if (r.token === null) break;
      seen.push(r.token);
      rest = r.rest;
    }
    expect(seen).toEqual(['a', ',', 'b']);
  });

  test('atEol=false consumes one trailing delim; atEol=true keeps it', () => {
    const noEol = strtokx('foo,', WS, ',', '', '', null, false);
    expect(noEol.token).toBe('foo');
    // atEol=false: the comma is consumed; nothing left
    expect(noEol.rest).toBe('');

    const yesEol = strtokx('foo,', WS, ',', '', '', null, true);
    expect(yesEol.token).toBe('foo');
    expect(yesEol.rest).toBe(',');
  });
});

describe('strtokx — quoted tokens', () => {
  test('single-quoted token kept with surrounding quotes', () => {
    const r = strtokx(
      "'hello world' next",
      WS,
      DELIM,
      QUOTE,
      '\\',
      null,
      false,
    );
    expect(r.token).toBe("'hello world'");
    expect(r.rest.trimStart()).toBe('next');
  });

  test('embedded escape inside single-quoted token', () => {
    const r = strtokx("'a\\'b' next", WS, DELIM, QUOTE, '\\', null, false);
    // The escape lets the inner ' be part of the token; closing is the
    // second un-escaped quote.
    expect(r.token).toBe("'a\\'b'");
  });

  test('doubled quotes inside single-quoted token are preserved', () => {
    const r = strtokx("'it''s' next", WS, DELIM, QUOTE, '\\', null, false);
    expect(r.token).toBe("'it''s'");
    // dequote should unwrap it.
    expect(dequote(r.token ?? '', "'")).toBe("it's");
  });

  test('double-quoted token kept verbatim', () => {
    const r = strtokx('"foo bar" rest', WS, DELIM, QUOTE, '\\', null, false);
    expect(r.token).toBe('"foo bar"');
  });

  test('E-string prefix activates single-quote with backslash escape', () => {
    const r = strtokx("E'a\\nb' rest", WS, DELIM, QUOTE, '\\', 'Ee', false);
    expect(r.token).toBe("'a\\nb'");
  });
});

describe('quoteIfNeeded', () => {
  test('no-op when value contains no escape-trigger chars', () => {
    expect(quoteIfNeeded('hello', ' ,', "'")).toBe('hello');
  });

  test('wraps when value contains a delim/whitespace char', () => {
    expect(quoteIfNeeded('hello world', ' ,', "'")).toBe("'hello world'");
    expect(quoteIfNeeded('a,b', ' ,', "'")).toBe("'a,b'");
  });

  test('wraps and doubles embedded quote', () => {
    expect(quoteIfNeeded("it's", ' ,', "'")).toBe("'it''s'");
  });

  test('embedded quote alone is enough to force quoting', () => {
    expect(quoteIfNeeded("it's", '', "'")).toBe("'it''s'");
  });

  test('double-quote variant', () => {
    expect(quoteIfNeeded('he said "hi"', ' ', '"')).toBe('"he said ""hi"""');
  });

  test('throws when quote is not exactly one character', () => {
    expect(() => quoteIfNeeded('x', '', '')).toThrow(/exactly one/);
    expect(() => quoteIfNeeded('x', '', "''")).toThrow(/exactly one/);
  });
});

describe('dequote', () => {
  test('returns value unchanged when not wrapped', () => {
    expect(dequote('hello', "'")).toBe('hello');
  });

  test('strips surrounding quote', () => {
    expect(dequote("'hello'", "'")).toBe('hello');
  });

  test('undoubles embedded quote', () => {
    expect(dequote("'it''s'", "'")).toBe("it's");
  });

  test('round-trips with quoteIfNeeded', () => {
    const samples = ['plain', 'has space', "it's", 'a,b,c', 'no-quote-needed'];
    for (const s of samples) {
      const quoted = quoteIfNeeded(s, ' ,', "'");
      expect(dequote(quoted, "'")).toBe(s);
    }
  });

  test('double-quote round trip', () => {
    const v = 'he said "hi"';
    const q = quoteIfNeeded(v, ' ', '"');
    expect(dequote(q, '"')).toBe(v);
  });
});

// ---------------------------------------------------------------------------
// quoteSqlLiteral / quoteSqlIdent — shared with the slash scanner.
// ---------------------------------------------------------------------------

describe('quoteSqlLiteral', () => {
  test('wraps a plain string in single quotes', () => {
    expect(quoteSqlLiteral('hello')).toBe("'hello'");
  });

  test('doubles embedded single quotes', () => {
    expect(quoteSqlLiteral("it's")).toBe("'it''s'");
  });

  test("emits E'…' form when value contains a backslash", () => {
    expect(quoteSqlLiteral('a\\b')).toBe("E'a\\\\b'");
  });

  test('empty string', () => {
    expect(quoteSqlLiteral('')).toBe("''");
  });
});

describe('quoteSqlIdent', () => {
  test('wraps a plain string in double quotes', () => {
    expect(quoteSqlIdent('foo')).toBe('"foo"');
  });

  test('doubles embedded double quotes', () => {
    expect(quoteSqlIdent('My"Table')).toBe('"My""Table"');
  });

  test('preserves single quotes and backslashes verbatim', () => {
    expect(quoteSqlIdent("a'b\\c")).toBe('"a\'b\\c"');
  });
});

// ---------------------------------------------------------------------------
// tryConsumeVarSubstitution — the substitution helper used by the SQL
// scanner. Behavioural coverage here lets the scanner test focus on
// integration with the surrounding state machine.
// ---------------------------------------------------------------------------

describe('tryConsumeVarSubstitution', () => {
  const lookup =
    (vars: Record<string, string>) =>
    (name: string): string | undefined =>
      Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;

  test('returns null without varLookup (substitution disabled)', () => {
    expect(tryConsumeVarSubstitution(':foo', 0, undefined)).toBeNull();
  });

  test('plain :NAME substitution', () => {
    const r = tryConsumeVarSubstitution(':foo', 0, lookup({ foo: 'bar' }));
    expect(r).toEqual({ end: 4, text: 'bar' });
  });

  test("':NAME' SQL-literal substitution", () => {
    const r = tryConsumeVarSubstitution(":'val'", 0, lookup({ val: "it's" }));
    expect(r).toEqual({ end: 6, text: "'it''s'" });
  });

  test(':"NAME" SQL-identifier substitution', () => {
    const r = tryConsumeVarSubstitution(
      ':"tbl"',
      0,
      lookup({ tbl: 'My"Table' }),
    );
    expect(r).toEqual({ end: 6, text: '"My""Table"' });
  });

  test('unknown variable echoes the literal :NAME', () => {
    const r = tryConsumeVarSubstitution(':unk', 0, lookup({}));
    expect(r).toEqual({ end: 4, text: ':unk' });
  });

  test("unknown variable echoes the literal :'NAME'", () => {
    const r = tryConsumeVarSubstitution(":'unk'", 0, lookup({}));
    expect(r).toEqual({ end: 6, text: ":'unk'" });
  });

  test(':: cast operator yields null (caller emits literally)', () => {
    expect(tryConsumeVarSubstitution('::', 0, lookup({}))).toBeNull();
  });

  test(': followed by non-identifier returns null', () => {
    expect(tryConsumeVarSubstitution(':+', 0, lookup({}))).toBeNull();
    expect(tryConsumeVarSubstitution(': ', 0, lookup({}))).toBeNull();
  });

  test(': followed by digit returns null (no leading-digit names)', () => {
    expect(tryConsumeVarSubstitution(':1', 0, lookup({ '1': 'x' }))).toBeNull();
  });

  test(': at end of input returns null', () => {
    expect(tryConsumeVarSubstitution(':', 0, lookup({}))).toBeNull();
  });

  test("empty name inside :'' returns null", () => {
    expect(tryConsumeVarSubstitution(":''", 0, lookup({}))).toBeNull();
  });

  test("unterminated :'NAME (no closing quote) returns null", () => {
    expect(
      tryConsumeVarSubstitution(":'foo", 0, lookup({ foo: 'x' })),
    ).toBeNull();
  });

  test('greedy name match stops at non-name char', () => {
    const r = tryConsumeVarSubstitution(
      ':foo.bar',
      0,
      lookup({ foo: 'X', bar: 'Y' }),
    );
    expect(r).toEqual({ end: 4, text: 'X' });
  });

  test('substitution at non-zero offset advances correctly', () => {
    // Mid-string call (caller has already advanced past leading text).
    const r = tryConsumeVarSubstitution(
      'pre :foo post',
      4,
      lookup({ foo: 'X' }),
    );
    expect(r).toEqual({ end: 8, text: 'X' });
  });
});
