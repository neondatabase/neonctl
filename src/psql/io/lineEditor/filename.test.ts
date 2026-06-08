import { describe, it, expect } from 'vitest';

import {
  detectQuoteStyle,
  doubleQuote,
  needsQuoting,
  quoteForCompletion,
  singleQuote,
  unquote,
} from './filename.js';

describe('needsQuoting', () => {
  it('returns false for bare safe filenames', () => {
    expect(needsQuoting('hello.txt')).toBe(false);
    expect(needsQuoting('/usr/local/bin/psql')).toBe(false);
    expect(needsQuoting('a-b_c.123')).toBe(false);
  });

  it('returns true for filenames with whitespace', () => {
    expect(needsQuoting('with space.sql')).toBe(true);
  });

  it('returns true for shell-special chars', () => {
    expect(needsQuoting('a$b')).toBe(true);
    expect(needsQuoting('with"quote')).toBe(true);
    expect(needsQuoting("with'quote")).toBe(true);
    expect(needsQuoting('back\\slash')).toBe(true);
  });

  it('returns true for empty string', () => {
    expect(needsQuoting('')).toBe(true);
  });
});

describe('singleQuote', () => {
  it('wraps a bare name in single quotes', () => {
    expect(singleQuote('hello.txt')).toBe("'hello.txt'");
  });

  it("escapes embedded single quotes via '\\''", () => {
    expect(singleQuote("o'brien.sql")).toBe("'o'\\''brien.sql'");
  });
});

describe('doubleQuote', () => {
  it('wraps a bare name in double quotes', () => {
    expect(doubleQuote('hello.txt')).toBe('"hello.txt"');
  });

  it('escapes embedded specials', () => {
    expect(doubleQuote('a"b\\c$d')).toBe('"a\\"b\\\\c\\$d"');
  });
});

describe('detectQuoteStyle', () => {
  it('returns none for unquoted input', () => {
    expect(detectQuoteStyle('hello')).toBe('none');
  });

  it('returns single while inside single quotes', () => {
    expect(detectQuoteStyle("'partial")).toBe('single');
  });

  it('returns double while inside double quotes', () => {
    expect(detectQuoteStyle('"partial')).toBe('double');
  });

  it('returns none after a closed quote', () => {
    expect(detectQuoteStyle("'closed' more")).toBe('none');
  });

  it('handles escaped quotes inside double quotes', () => {
    expect(detectQuoteStyle('"a\\"b')).toBe('double');
  });
});

describe('quoteForCompletion', () => {
  it('emits bare candidate when safe and unquoted', () => {
    expect(quoteForCompletion('foo.txt', 'none')).toBe('foo.txt');
  });

  it('wraps unsafe candidate in single quotes when starting fresh', () => {
    expect(quoteForCompletion('with space.txt', 'none')).toBe(
      "'with space.txt'",
    );
  });

  it('escapes inside single-quote context without closing', () => {
    expect(quoteForCompletion("o'b", 'single')).toBe("o'\\''b");
  });

  it('escapes inside double-quote context without closing', () => {
    expect(quoteForCompletion('a"b', 'double')).toBe('a\\"b');
  });
});

describe('unquote', () => {
  it('returns identity for a bare string', () => {
    expect(unquote('hello.txt')).toBe('hello.txt');
  });

  it('strips single quotes', () => {
    expect(unquote("'hello world.txt'")).toBe('hello world.txt');
  });

  it('strips double quotes and resolves escapes', () => {
    expect(unquote('"a\\"b"')).toBe('a"b');
  });

  it('handles a partially open single quote', () => {
    expect(unquote("'partial")).toBe('partial');
  });

  it('handles mixed quoting', () => {
    expect(unquote("/path/'sub dir'/file.txt")).toBe('/path/sub dir/file.txt');
  });
});
