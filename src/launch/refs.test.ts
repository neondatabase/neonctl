/**
 * Tests for the load-bearing invariants of the `Ref<T>` Proxy. Each behavior
 * is a known JS foot-gun; the comments next to each test name what's being
 * defended.
 */
import { inspect } from 'node:util';

import { describe, it, expect } from 'vitest';

import { makeRef, isRef } from './refs.js';

describe('makeRef — required Proxy behaviors', () => {
  it('1. JSON.stringify produces the marker envelope', () => {
    const ref = makeRef('x');
    expect(JSON.stringify(ref)).toBe('{"__ref":"x","__kind":"ref"}');
  });

  it('2. template-string interpolation throws with a corrective example', () => {
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

  it('4a. opts arg is preserved verbatim into __opts (no stringification, all keys)', () => {
    const base = makeRef('x');
    const opts = { pooled: false, role: 'app_user', database: 'neondb' };
    const called = (base as unknown as (o: unknown) => unknown)(opts);
    const marker = JSON.parse(JSON.stringify(called)) as {
      __opts: Record<string, unknown>;
    };
    expect(marker.__opts).toEqual(opts);
  });

  it('4b. two calls each produce independent refs (no shared opts state)', () => {
    const base = makeRef('x');
    const callable = base as unknown as (o: unknown) => unknown;
    const a = callable({ pooled: true });
    const b = callable({ pooled: false });
    const aMarker = JSON.parse(JSON.stringify(a)) as {
      __opts: { pooled: boolean };
    };
    const bMarker = JSON.parse(JSON.stringify(b)) as {
      __opts: { pooled: boolean };
    };
    expect(aMarker.__opts.pooled).toBe(true);
    expect(bMarker.__opts.pooled).toBe(false);
    // And the base ref still has no __opts (the calls didn't mutate it).
    const baseMarker = JSON.parse(JSON.stringify(base)) as Record<
      string,
      unknown
    >;
    expect(baseMarker.__opts).toBeUndefined();
  });

  it('5. Object.assign({}, ref) preserves the marker keys', () => {
    const ref = makeRef('x');
    const flat = Object.assign({}, ref) as Record<string, unknown>;
    expect(flat.__ref).toBe('x');
    expect(flat.__kind).toBe('ref');
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
