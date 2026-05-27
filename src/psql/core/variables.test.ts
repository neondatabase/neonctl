import { describe, expect, test, vi } from 'vitest';

import { createVarStore, VarStore } from './variables.js';

describe('VarStore — basics', () => {
  test('set/get/has/unset happy path', () => {
    const v = createVarStore();
    expect(v.set('FOO', 'bar')).toBe(true);
    expect(v.get('FOO')).toBe('bar');
    expect(v.has('FOO')).toBe(true);
    expect(v.unset('FOO')).toBe(true);
    expect(v.has('FOO')).toBe(false);
    expect(v.get('FOO')).toBeUndefined();
    expect(v.unset('FOO')).toBe(false);
  });

  test('factory returns a fresh independent instance', () => {
    const a = createVarStore();
    const b = createVarStore();
    a.set('x', '1');
    expect(b.has('x')).toBe(false);
  });

  test('class constructor also works', () => {
    const v = new VarStore();
    v.set('a', 'b');
    expect(v.get('a')).toBe('b');
  });

  test('entries() yields all key/value pairs in insertion order', () => {
    const v = createVarStore();
    v.set('c', '3');
    v.set('a', '1');
    v.set('b', '2');
    expect([...v.entries()]).toEqual([
      ['c', '3'],
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  test('overwriting a value keeps insertion position', () => {
    const v = createVarStore();
    v.set('a', '1');
    v.set('b', '2');
    v.set('a', '99');
    expect([...v.entries()]).toEqual([
      ['a', '99'],
      ['b', '2'],
    ]);
  });
});

describe('VarStore — name validation', () => {
  test.each([
    ['valid_name', true],
    ['Valid_Name_2', true],
    ['_leading_underscore', true],
    ['x', true],
    ['', false],
    ['1leading_digit', false],
    ['has-dash', false],
    ['has space', false],
    ['has.dot', false],
    ['unicode-ñ', false],
  ])('set(%j) returns %s', (name, expected) => {
    const v = createVarStore();
    expect(v.set(name, 'v')).toBe(expected);
    expect(v.has(name)).toBe(expected);
  });
});

describe('VarStore — hooks', () => {
  test('hook fires on set with the new value', () => {
    const v = createVarStore();
    const hook = vi.fn().mockReturnValue(true);
    v.addHook('X', hook);
    // Replay on registration with current value (undefined → null).
    expect(hook).toHaveBeenCalledWith(null);

    v.set('X', 'hello');
    expect(hook).toHaveBeenLastCalledWith('hello');
    expect(v.get('X')).toBe('hello');
  });

  test('hook returning false vetoes the set; value left unchanged', () => {
    const v = createVarStore();
    v.set('X', 'original');
    v.addHook('X', () => false);
    expect(v.set('X', 'rejected')).toBe(false);
    expect(v.get('X')).toBe('original');
  });

  test('multiple hooks: all must accept', () => {
    const v = createVarStore();
    const accept = vi.fn().mockReturnValue(true);
    const reject = vi.fn().mockReturnValue(false);
    v.addHook('X', accept);
    v.addHook('X', reject);
    expect(v.set('X', 'v')).toBe(false);
    expect(v.has('X')).toBe(false);
  });

  test('hook is replayed on registration with current value', () => {
    const v = createVarStore();
    v.set('X', 'preset');
    const hook = vi.fn().mockReturnValue(true);
    v.addHook('X', hook);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith('preset');
  });

  test('unset notifies hooks with null and removes the value', () => {
    const v = createVarStore();
    v.set('X', 'value');
    const hook = vi.fn().mockReturnValue(true);
    v.addHook('X', hook);
    hook.mockClear();
    expect(v.unset('X')).toBe(true);
    expect(hook).toHaveBeenCalledWith(null);
    expect(v.has('X')).toBe(false);
  });

  test('hooks survive unset and apply on re-set', () => {
    const v = createVarStore();
    const hook = vi.fn().mockReturnValue(true);
    v.addHook('X', hook);
    v.set('X', 'a');
    v.unset('X');
    hook.mockClear();
    v.set('X', 'b');
    expect(hook).toHaveBeenCalledWith('b');
    expect(v.get('X')).toBe('b');
  });

  test('addHook with invalid name is a no-op', () => {
    const v = createVarStore();
    const hook = vi.fn().mockReturnValue(true);
    v.addHook('1bad', hook);
    expect(hook).not.toHaveBeenCalled();
  });

  test('addHook consumes substitute on initial null replay (upstream SetVariableHooks parity)', () => {
    // Upstream `SetVariableHooks` runs the substitute hook immediately:
    //   `current->value = (*shook)(current->value)`. For variables whose
    // substitute returns a non-null default on null input
    // (`bool_substitute_hook`, `verbosity_substitute_hook`, ...), the
    // initial value gets seeded so `\echo :NAME` shows the default token
    // rather than the literal `:NAME` string.
    const v = createVarStore();
    const hook = vi.fn((newValue: string | null) => {
      if (newValue === null) return { substitute: 'off' as const };
      return true;
    });
    v.addHook('X', hook);
    expect(v.get('X')).toBe('off');
    // The hook is re-run with the substituted value so derived state
    // (e.g. settings.onErrorStop) can be applied off the canonical
    // post-substitute string. That re-run pattern mirrors upstream's
    // `(void)(*ahook)(current->value)` right after the substitute.
    expect(hook).toHaveBeenCalledWith(null);
    expect(hook).toHaveBeenCalledWith('off');
  });

  test('addHook does not seed when substitute returns null/true', () => {
    // Variables with NULL substitute hooks upstream (PROMPT1/2/3, HISTFILE)
    // leave the slot empty until explicitly set; our hook that returns
    // `true` (no substitute) on null replay reproduces that.
    const v = createVarStore();
    const hook = vi.fn(() => true);
    v.addHook('X', hook);
    expect(v.has('X')).toBe(false);
  });

  test('unset re-stores substitute and re-notifies hook (existing behavior preserved)', () => {
    // The unset → substitute → re-store path landed in commit 5bd6100.
    // After the addHook fix that consumes the initial-replay substitute,
    // this path is exercised on every `\unset` for substitute-aware vars.
    const v = createVarStore();
    const hook = vi.fn((newValue: string | null) => {
      if (newValue === null) return { substitute: 'default' as const };
      return true;
    });
    v.addHook('X', hook);
    v.set('X', 'custom');
    expect(v.get('X')).toBe('custom');
    hook.mockClear();
    v.unset('X');
    expect(v.get('X')).toBe('default');
    // Hook called with null first (substitute returned), then with the
    // substituted value to let derived state sync.
    expect(hook).toHaveBeenNthCalledWith(1, null);
    expect(hook).toHaveBeenNthCalledWith(2, 'default');
  });
});

describe('VarStore — asBool', () => {
  test.each([
    ['on', true],
    ['ON', true],
    ['On', true],
    ['off', false],
    ['Off', false],
    ['OFF', false],
    ['true', true],
    ['TRUE', true],
    ['t', true],
    ['tr', true],
    ['false', false],
    ['fa', false],
    ['yes', true],
    ['y', true],
    ['no', false],
    ['n', false],
    ['1', true],
    ['0', false],
    ['of', false],
    ['42', true],
    ['-1', true],
    ['0x0', false],
    ['0x10', true],
  ])('parses %j as %s', (input, expected) => {
    const v = createVarStore();
    v.set('flag', input);
    expect(v.asBool('flag')).toBe(expected);
  });

  test('ambiguous single "o" falls back to default', () => {
    const v = createVarStore();
    v.set('flag', 'o');
    expect(v.asBool('flag', false)).toBe(false);
    expect(v.asBool('flag', true)).toBe(true);
  });

  test('unrecognised value returns default', () => {
    const v = createVarStore();
    v.set('flag', 'maybe');
    expect(v.asBool('flag', true)).toBe(true);
    expect(v.asBool('flag', false)).toBe(false);
  });

  test('unset returns default', () => {
    const v = createVarStore();
    expect(v.asBool('missing')).toBe(false);
    expect(v.asBool('missing', true)).toBe(true);
  });
});

describe('VarStore — asTriple', () => {
  test.each([
    ['on', 'on'],
    ['ON', 'on'],
    ['off', 'off'],
    ['OFF', 'off'],
    ['auto', 'auto'],
    ['AUTO', 'auto'],
    ['a', 'auto'],
    ['au', 'auto'],
    ['true', 'on'],
    ['false', 'off'],
    ['yes', 'on'],
    ['no', 'off'],
    ['1', 'on'],
    ['0', 'off'],
  ] as const)('parses %j as %s', (input, expected) => {
    const v = createVarStore();
    v.set('t', input);
    expect(v.asTriple('t', 'on')).toBe(expected);
  });

  test('unset returns default', () => {
    const v = createVarStore();
    expect(v.asTriple('missing', 'auto')).toBe('auto');
  });

  test('invalid value returns error', () => {
    const v = createVarStore();
    v.set('t', 'banana');
    const result = v.asTriple('t', 'on');
    expect(result).toEqual({
      error: expect.stringContaining('banana') as unknown as string,
    });
  });
});

describe('VarStore — asInt', () => {
  test('parses decimal', () => {
    const v = createVarStore();
    v.set('n', '42');
    expect(v.asInt('n')).toBe(42);
  });

  test('parses negative', () => {
    const v = createVarStore();
    v.set('n', '-7');
    expect(v.asInt('n')).toBe(-7);
  });

  test('parses hex (base 0)', () => {
    const v = createVarStore();
    v.set('n', '0x10');
    expect(v.asInt('n')).toBe(16);
  });

  test('parses octal (leading 0, base 0)', () => {
    const v = createVarStore();
    v.set('n', '010');
    expect(v.asInt('n')).toBe(8);
  });

  test('returns default when unset', () => {
    const v = createVarStore();
    expect(v.asInt('missing')).toBe(0);
    expect(v.asInt('missing', 99)).toBe(99);
  });

  test('errors on garbage', () => {
    const v = createVarStore();
    v.set('n', 'abc');
    expect(v.asInt('n')).toEqual({
      error: expect.stringContaining('abc') as unknown as string,
    });
  });

  test('errors on trailing junk', () => {
    const v = createVarStore();
    v.set('n', '42xyz');
    const r = v.asInt('n');
    expect(typeof r).toBe('object');
  });

  test('errors when out of 32-bit signed range', () => {
    const v = createVarStore();
    v.set('n', '9999999999');
    const r = v.asInt('n');
    expect(typeof r).toBe('object');
  });

  test('accepts boundary values', () => {
    const v = createVarStore();
    v.set('n', '2147483647');
    expect(v.asInt('n')).toBe(2147483647);
    v.set('n', '-2147483648');
    expect(v.asInt('n')).toBe(-2147483648);
  });
});
