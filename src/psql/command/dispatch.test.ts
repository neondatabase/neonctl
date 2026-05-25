import { describe, expect, test } from 'vitest';

import type {
  BackslashCmdSpec,
  BackslashContext,
  BackslashResult,
} from '../types/backslash.js';
import { createVarStore } from '../core/variables.js';
import { defaultSettings } from '../core/settings.js';

import {
  createBackslashRegistry,
  defaultRegistry,
  dispatchBackslash,
  makeContext,
} from './dispatch.js';

const okSpec = (name: string, aliases?: string[]): BackslashCmdSpec => ({
  name,
  aliases,
  run: (): Promise<BackslashResult> => Promise.resolve({ status: 'ok' }),
});

describe('BackslashRegistry — register/lookup/alias', () => {
  test('lookup by primary name', () => {
    const r = createBackslashRegistry();
    r.register(okSpec('foo'));
    const spec = r.lookup('foo');
    expect(spec?.name).toBe('foo');
  });

  test('lookup by alias resolves to primary spec', () => {
    const r = createBackslashRegistry();
    r.register(okSpec('quit', ['q', 'bye']));
    expect(r.lookup('quit')?.name).toBe('quit');
    expect(r.lookup('q')?.name).toBe('quit');
    expect(r.lookup('bye')?.name).toBe('quit');
  });

  test('unknown name returns undefined', () => {
    const r = createBackslashRegistry();
    expect(r.lookup('nope')).toBeUndefined();
  });

  test('all() iterates primary specs only', () => {
    const r = createBackslashRegistry();
    r.register(okSpec('foo', ['f']));
    r.register(okSpec('bar'));
    const names = [...r.all()].map((s) => s.name).sort();
    expect(names).toEqual(['bar', 'foo']);
  });

  test('re-registering same name overrides', () => {
    const r = createBackslashRegistry();
    r.register(okSpec('foo'));
    let called = false;
    r.register({
      name: 'foo',
      run: (): Promise<BackslashResult> => {
        called = true;
        return Promise.resolve({ status: 'ok' });
      },
    });
    const spec = r.lookup('foo');
    void spec?.run({} as BackslashContext);
    expect(called).toBe(true);
  });
});

describe('dispatchBackslash', () => {
  test('runs the matched command and returns its result', async () => {
    const r = createBackslashRegistry();
    r.register({
      name: 'echo',
      run: (): Promise<BackslashResult> =>
        Promise.resolve({ status: 'reset-buf', newBuf: '' }),
    });
    const settings = defaultSettings(createVarStore());
    const ctx = makeContext({
      settings,
      cmdName: 'echo',
      rawArgs: '',
      queryBuf: '',
    });
    const result = await dispatchBackslash(r, 'echo', ctx);
    expect(result.status).toBe('reset-buf');
  });

  test('unknown command returns error', async () => {
    const r = createBackslashRegistry();
    const settings = defaultSettings(createVarStore());
    const ctx = makeContext({
      settings,
      cmdName: 'mystery',
      rawArgs: '',
      queryBuf: '',
    });
    const result = await dispatchBackslash(r, 'mystery', ctx);
    expect(result.status).toBe('error');
  });
});

describe('BackslashContext — nextArg / restOfLine', () => {
  const makeCtx = (rawArgs: string): BackslashContext => {
    const settings = defaultSettings(createVarStore());
    return makeContext({
      settings,
      cmdName: 'test',
      rawArgs,
      queryBuf: '',
    });
  };

  test('returns null on empty input', () => {
    const ctx = makeCtx('');
    expect(ctx.nextArg('normal')).toBeNull();
    expect(ctx.restOfLine()).toBe('');
  });

  test('consumes args sequentially', () => {
    const ctx = makeCtx('  alpha beta gamma');
    expect(ctx.nextArg('normal')).toBe('alpha');
    expect(ctx.nextArg('normal')).toBe('beta');
    expect(ctx.nextArg('normal')).toBe('gamma');
    expect(ctx.nextArg('normal')).toBeNull();
  });

  test('respects single-quoted strings', () => {
    const ctx = makeCtx("'hello world' next");
    expect(ctx.nextArg('normal')).toBe('hello world');
    expect(ctx.nextArg('normal')).toBe('next');
  });

  test('respects double-quoted strings', () => {
    const ctx = makeCtx('"a b c" tail');
    expect(ctx.nextArg('normal')).toBe('"a b c"');
    expect(ctx.nextArg('normal')).toBe('tail');
  });

  test('restOfLine returns trimmed tail and consumes', () => {
    const ctx = makeCtx('  rest of line goes here');
    expect(ctx.restOfLine()).toBe('rest of line goes here');
    expect(ctx.restOfLine()).toBe('');
  });

  test('whole-line mode returns entire tail', () => {
    const ctx = makeCtx('  cmd arg1 arg2');
    expect(ctx.nextArg('whole-line')).toBe('cmd arg1 arg2');
    expect(ctx.nextArg('normal')).toBeNull();
  });

  test('var substitution expands :var', () => {
    const settings = defaultSettings(createVarStore());
    settings.vars.set('FOO', 'bar');
    const ctx = makeContext({
      settings,
      cmdName: 'test',
      rawArgs: ':FOO baz',
      queryBuf: '',
    });
    expect(ctx.nextArg('normal')).toBe('bar');
    expect(ctx.nextArg('normal')).toBe('baz');
  });

  test('mixed args after restOfLine returns empty', () => {
    const ctx = makeCtx('first second third');
    expect(ctx.nextArg('normal')).toBe('first');
    expect(ctx.restOfLine()).toBe('second third');
    expect(ctx.nextArg('normal')).toBeNull();
  });
});

describe('defaultRegistry()', () => {
  test('includes meta commands', () => {
    const r = defaultRegistry();
    for (const name of [
      'q',
      '!',
      'cd',
      'echo',
      'qecho',
      'warn',
      'prompt',
      'set',
      'unset',
      'getenv',
      'setenv',
      'errverbose',
      'timing',
    ]) {
      expect(r.lookup(name), `missing meta command \\${name}`).toBeDefined();
    }
  });

  test('includes format commands', () => {
    const r = defaultRegistry();
    for (const name of [
      'a',
      'C',
      'f',
      'H',
      't',
      'T',
      'x',
      'encoding',
      'pset',
    ]) {
      expect(r.lookup(name), `missing format command \\${name}`).toBeDefined();
    }
  });

  test('alias \\quit resolves to \\q', () => {
    const r = defaultRegistry();
    expect(r.lookup('quit')?.name).toBe('q');
  });
});
