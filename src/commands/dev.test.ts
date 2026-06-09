import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { test } from '../test_utils/fixtures';
import {
  diffUnits,
  formatEnvSummary,
  type RunningUnit,
  type ServedUnit,
} from './dev.js';

describe('dev', () => {
  test('exits 1 when no --source and no neon.ts is found', async ({
    testCliCommand,
  }) => {
    // Runs in the repo root, which has no neon.ts: nothing to serve.
    await testCliCommand(['dev'], {
      code: 1,
      stderr:
        'ERROR: No --source given and no neon.ts found. Pass --source <path> ' +
        'to run a single function, or add a neon.ts that declares functions ' +
        'under `preview.functions`.',
    });
  });

  test('exits 1 when --port is given without --source', async ({
    testCliCommand,
  }) => {
    await testCliCommand(['dev', '--port', '3000'], {
      code: 1,
      stderr:
        'ERROR: --port can only be used with --source. To set ports for the ' +
        'functions in neon.ts, give each one a `dev.port` in its config.',
    });
  });

  test('exits 1 when --source points at a file that does not exist', async ({
    testCliCommand,
  }) => {
    const missing = join(process.cwd(), 'does-not-exist.ts');
    await testCliCommand(['dev', '--source', missing], { code: 1 });
  });
});

/**
 * The slug-keyed diff that powers neon.ts hot-reload: editing neon.ts while `neon dev` runs
 * should add new functions and drop removed ones without disturbing the functions that
 * stayed the same. These cover the decision (which units to add/remove/restart); the
 * side effects (spawn/kill) are driven by the supervisor around it.
 */
describe('diffUnits', () => {
  const unit = (slug: string, configKey: string): ServedUnit => ({
    slug,
    source: `/fns/${slug}.ts`,
    bundleDir: `/tmp/${slug}`,
    childEnv: {},
    label: slug,
    configKey,
  });

  const runningOf = (...units: ServedUnit[]): RunningUnit[] =>
    units.map((u) => ({
      unit: u,
      child: null,
      boundPort: null,
      everReady: false,
      restartTimer: null,
      watcher: null,
      status: 'ready',
    }));

  it('adds a newly declared function and leaves existing ones untouched', () => {
    const existing = unit('a', 'ka');
    const running = runningOf(existing);
    const desired = [unit('a', 'ka'), unit('b', 'kb')];

    const plan = diffUnits(running, desired);

    expect(plan.add.map((u) => u.slug)).toEqual(['b']);
    expect(plan.remove).toEqual([]);
    expect(plan.restart).toEqual([]);
    // The existing unit's running entry is the very same object — never replaced.
    expect(running[0].unit).toBe(existing);
  });

  it('removes a function dropped from neon.ts', () => {
    const running = runningOf(unit('a', 'ka'), unit('b', 'kb'));

    const plan = diffUnits(running, [unit('a', 'ka')]);

    expect(plan.remove.map((r) => r.unit.slug)).toEqual(['b']);
    expect(plan.add).toEqual([]);
    expect(plan.restart).toEqual([]);
  });

  it('restarts in place a function whose config changed (new configKey)', () => {
    const running = runningOf(unit('a', 'ka-old'));

    const plan = diffUnits(running, [unit('a', 'ka-new')]);

    expect(plan.restart.map((r) => r.unit.slug)).toEqual(['a']);
    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual([]);
    // Restart adopts the new config onto the same running entry (kept, not re-created).
    expect(running[0].unit.configKey).toBe('ka-new');
  });

  it('leaves an unchanged function alone (no add/remove/restart)', () => {
    const running = runningOf(unit('a', 'ka'));

    const plan = diffUnits(running, [unit('a', 'ka')]);

    expect(plan).toEqual({ remove: [], restart: [], add: [] });
  });

  it('removes everything when neon.ts is deleted (null desired)', () => {
    const running = runningOf(unit('a', 'ka'), unit('b', 'kb'));

    const plan = diffUnits(running, null);

    expect(plan.remove.map((r) => r.unit.slug)).toEqual(['a', 'b']);
    expect(plan.add).toEqual([]);
    expect(plan.restart).toEqual([]);
  });

  it('handles a mix: add one, remove one, restart one, keep one', () => {
    const keep = unit('keep', 'k');
    const running = runningOf(keep, unit('drop', 'd'), unit('change', 'c-old'));

    const plan = diffUnits(running, [
      unit('keep', 'k'),
      unit('change', 'c-new'),
      unit('new', 'n'),
    ]);

    expect(plan.add.map((u) => u.slug)).toEqual(['new']);
    expect(plan.remove.map((r) => r.unit.slug)).toEqual(['drop']);
    expect(plan.restart.map((r) => r.unit.slug)).toEqual(['change']);
    // 'keep' is never in any bucket and its object identity is preserved.
    expect(running[0].unit).toBe(keep);
  });
});

/**
 * The transparent env line in the dev banner: shows the *names* of the env vars injected
 * into each function (Neon branch vars + the function's own neon.ts env keys), never values.
 */
describe('formatEnvSummary', () => {
  it('lists Neon branch vars and neon.ts keys, each sorted, in distinct groups', () => {
    expect(
      formatEnvSummary({
        neon: ['DATABASE_URL_UNPOOLED', 'DATABASE_URL'],
        fn: ['STRIPE_KEY', 'RESEND_API_KEY'],
      }),
    ).toBe(
      'env: DATABASE_URL, DATABASE_URL_UNPOOLED · neon.ts: RESEND_API_KEY, STRIPE_KEY',
    );
  });

  it('shows only the Neon group when the function declares no env', () => {
    expect(formatEnvSummary({ neon: ['DATABASE_URL'], fn: [] })).toBe(
      'env: DATABASE_URL',
    );
  });

  it('shows only the neon.ts group when no Neon env was injected', () => {
    expect(formatEnvSummary({ neon: [], fn: ['RESEND_API_KEY'] })).toBe(
      'neon.ts: RESEND_API_KEY',
    );
  });

  it('returns an empty string when nothing is injected (caller skips the line)', () => {
    expect(formatEnvSummary({ neon: [], fn: [] })).toBe('');
    expect(formatEnvSummary(undefined)).toBe('');
  });
});
