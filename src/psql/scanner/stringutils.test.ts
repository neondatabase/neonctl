import { describe, expect, test } from 'vitest';

import { dequote, quoteIfNeeded, strtokx } from './stringutils.js';

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
