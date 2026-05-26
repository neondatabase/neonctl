/**
 * Ports the six Spike 0.2 assertions into vitest. These are the load-bearing
 * invariants of the `Ref<T>` Proxy — spec §2.4 + §11 #17/#18/#44. Tests
 * pinned in code so regressions surface in CI, not in user reports.
 */
import { inspect } from 'node:util';

import { describe, it, expect } from 'vitest';

import { makeRef, isRef, walkAndResolve } from './refs.js';

describe('makeRef — six required Proxy behaviors', () => {
  it('1. JSON.stringify produces the marker envelope', () => {
    const ref = makeRef('x');
    expect(JSON.stringify(ref)).toBe('{"__ref":"x","__kind":"ref"}');
  });

  it('2. template-string interpolation throws with the spec §2.4 corrective example', () => {
    const ref = makeRef('x');
    expect(() => {
      // Force the Symbol.toPrimitive path — eslint can collapse a single-arg
      // template, so we add a literal suffix.
      const sink = `${ref as unknown as string}/`;
      void sink;
    }).toThrow(
      /spec: \(\{ db \}\) => \(\{ env: \{ DATABASE_URL: db\.connectionString \} \}\)/,
    );
  });

  it('3. util.inspect.custom hook is reachable on the proxy', () => {
    const ref = makeRef('x');
    const customFn = (ref as unknown as Record<symbol, unknown>)[
      inspect.custom
    ];
    expect(typeof customFn).toBe('function');
    expect((customFn as () => string)()).toMatch(/^Ref<string>\(x/);
  });

  it('4. calling the ref returns a new ref tagged with opts', () => {
    const base = makeRef('x');
    const called = (base as unknown as (o: unknown) => unknown)({
      pooled: false,
    });
    const baseStr = JSON.stringify(base);
    const calledStr = JSON.stringify(called);
    expect(baseStr).not.toBe(calledStr);
    expect(calledStr).toMatch(/"pooled":false/);
    expect(calledStr).toMatch(/"__ref":"x"/);
  });

  it('5. Object.assign({}, ref) preserves the marker keys', () => {
    const ref = makeRef('x');
    const flat = Object.assign({}, ref) as Record<string, unknown>;
    expect(flat.__ref).toBe('x');
    expect(flat.__kind).toBe('ref');
  });

  it('6. structuredClone(ref) throws (Bugzilla 1269327 — Proxy incompat)', () => {
    const ref = makeRef('x');
    expect(() => structuredClone(ref)).toThrow();
  });
});

describe('isRef', () => {
  it('detects refs', () => {
    expect(isRef(makeRef('x'))).toBe(true);
  });
  it('rejects plain objects', () => {
    expect(isRef({ __ref: 'x' })).toBe(false);
    expect(isRef({ __kind: 'ref' })).toBe(false);
    expect(isRef({})).toBe(false);
    expect(isRef(null)).toBe(false);
    expect(isRef('string')).toBe(false);
  });
});

describe('walkAndResolve', () => {
  it('replaces refs with table values', () => {
    const table = new Map<string, unknown>();
    table.set('db.connectionString', 'postgres://...');
    const env = { DATABASE_URL: makeRef('db.connectionString') };
    const resolved = walkAndResolve(env, table);
    expect(resolved).toEqual({ DATABASE_URL: 'postgres://...' });
  });
  it('passes through non-ref leaves', () => {
    const table = new Map<string, unknown>();
    const env = { FOO: 'bar', NUM: 42 };
    expect(walkAndResolve(env, table)).toEqual({ FOO: 'bar', NUM: 42 });
  });
  it('throws on unresolved refs', () => {
    const table = new Map<string, unknown>();
    expect(() => walkAndResolve({ X: makeRef('missing.id') }, table)).toThrow(
      /Unresolved Ref<T>.*missing\.id/,
    );
  });
  it('recurses into nested objects and arrays', () => {
    const table = new Map<string, unknown>([['db.host', 'localhost']]);
    const env = { nested: { arr: [makeRef('db.host'), 'literal'] } };
    expect(walkAndResolve(env, table)).toEqual({
      nested: { arr: ['localhost', 'literal'] },
    });
  });
});
