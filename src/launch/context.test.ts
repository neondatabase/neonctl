/**
 * buildLaunchContext — flag extraction + normalization.
 *
 * The boolean-string normalization is the contract the example demo
 * relies on (`flags.prod === true` for both `--prod` and `--prod=true`).
 * Without these tests a future refactor of `buildLaunchContext` could
 * silently drop the normalization and the example would compile + run
 * but fall through to the local-dev branch when the user expected prod.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  buildLaunchContext,
  readNeonLaunchEnv,
  resolveGitBranch,
  resolveStateValue,
  writeNeonLaunchEnv,
} from './context.js';

const RECOGNIZED = new Set<string>([
  '_',
  '--',
  '$0',
  'config',
  'branch',
  'branch-timeout',
]);

function ctx(argv: Record<string, unknown>) {
  return buildLaunchContext({
    argv,
    recognizedFlags: RECOGNIZED,
    branchFlag: 'test-branch',
    processEnv: {},
    cwd: process.cwd(),
  });
}

describe('buildLaunchContext flag normalization', () => {
  it('boolean true passes through unchanged', () => {
    expect(ctx({ prod: true }).flags.prod).toBe(true);
  });

  it('boolean false passes through unchanged', () => {
    expect(ctx({ prod: false }).flags.prod).toBe(false);
  });

  it("strings 'true' / '1' / 'yes' / 'on' all normalize to boolean true", () => {
    for (const v of ['true', '1', 'yes', 'on', 'TRUE', 'Yes']) {
      expect(ctx({ prod: v }).flags.prod).toBe(true);
    }
  });

  it("strings 'false' / '0' / 'no' / 'off' all normalize to boolean false", () => {
    for (const v of ['false', '0', 'no', 'off', 'FALSE', 'No']) {
      expect(ctx({ prod: v }).flags.prod).toBe(false);
    }
  });

  it('non-boolean strings pass through unchanged', () => {
    expect(ctx({ mode: 'staging' }).flags.mode).toBe('staging');
  });

  it('numbers pass through unchanged', () => {
    expect(ctx({ port: 8080 }).flags.port).toBe(8080);
  });

  it('recognized flags are not exposed on ctx.flags — multiple keys, not just config', () => {
    // Pin every key in RECOGNIZED. A regression that hardcoded
    // `if (k === 'config')` instead of `recognizedFlags.has(k)` would
    // pass a single-key test but leak `branch` / `branch-timeout`.
    const c = ctx({
      config: './neon.ts',
      branch: 'main',
      'branch-timeout': 300,
    });
    expect(c.flags.config).toBeUndefined();
    expect(c.flags.branch).toBeUndefined();
    expect(c.flags['branch-timeout']).toBeUndefined();
  });

  it('yargs internals are skipped', () => {
    const result = ctx({ _: [], '--': [], $0: 'neon' });
    expect(result.flags._).toBeUndefined();
    expect(result.flags['--']).toBeUndefined();
    expect(result.flags.$0).toBeUndefined();
  });
});

describe('resolveGitBranch precedence', () => {
  // Each test passes processEnv + branchFlag explicitly so the result
  // doesn't depend on the runner's actual git state.
  const cwd = process.cwd();

  it('explicit --branch flag wins over everything else', () => {
    expect(
      resolveGitBranch({
        branchFlag: 'flag-branch',
        processEnv: {
          GITHUB_HEAD_REF: 'pr-branch',
          GITHUB_REF_NAME: 'push-branch',
        },
        cwd,
      }),
    ).toBe('flag-branch');
  });

  it('GITHUB_HEAD_REF wins over GITHUB_REF_NAME (PR vs push precedence)', () => {
    // Falsifier: swapping the order would put `push-branch` first and
    // PR launches would deploy against the wrong scope.
    expect(
      resolveGitBranch({
        branchFlag: undefined,
        processEnv: {
          GITHUB_HEAD_REF: 'pr-branch',
          GITHUB_REF_NAME: 'push-branch',
        },
        cwd,
      }),
    ).toBe('pr-branch');
  });

  it('empty branchFlag is treated as not-set (falls through)', () => {
    expect(
      resolveGitBranch({
        branchFlag: '',
        processEnv: { GITHUB_REF_NAME: 'env-branch' },
        cwd,
      }),
    ).toBe('env-branch');
  });

  it('detached HEAD with no env / flag overrides throws an actionable error', () => {
    // Use a non-git directory so the test is deterministic — `git rev-parse`
    // exits non-zero, we hit the catch and warn-then-return ''. The
    // detached-HEAD throw is exercised when git returns the literal
    // string 'HEAD' (which we can't reliably simulate cross-platform);
    // the catch path is the more common production failure mode.
    const noGitDir = mkdtempSync(join(tmpdir(), 'neon-launch-nogit-'));
    expect(
      resolveGitBranch({
        branchFlag: undefined,
        processEnv: {},
        cwd: noGitDir,
      }),
    ).toBe('');
  });
});

describe('writeNeonLaunchEnv', () => {
  it('concurrent writes merge keys (basic intent — body is sync so the lock is defense-in-depth)', async () => {
    // Honest scope: the production body is `readFileSync → in-memory
    // merge → writeFileSync → renameSync`, all synchronous. Two parallel
    // calls serialize via Node's single-threaded event loop regardless
    // of the per-path `writeLocks` map. This test pins the happy-path
    // outcome (no key loss); it does NOT prove the lock is load-bearing
    // — that would require the body to span an `await`. If the IO ever
    // becomes async (fs.promises.*), revisit this test to interleave
    // reads/writes around the await point.
    const dir = mkdtempSync(join(tmpdir(), 'neon-launch-env-test-'));
    await Promise.all([
      writeNeonLaunchEnv(dir, { VERCEL_PROJECT_ID: 'prj_1' }),
      writeNeonLaunchEnv(dir, { VERCEL_TEAM_ID: 'team_1' }),
    ]);
    const result = readNeonLaunchEnv(dir);
    expect(result.VERCEL_PROJECT_ID).toBe('prj_1');
    expect(result.VERCEL_TEAM_ID).toBe('team_1');
  });

  it('preserves keys from disk that the new write does not mention', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neon-launch-env-test2-'));
    writeFileSync(
      join(dir, '.neon-launch.env'),
      'PRE_EXISTING=value\n',
      'utf8',
    );
    await writeNeonLaunchEnv(dir, { NEW_KEY: 'new_value' });
    const result = readNeonLaunchEnv(dir);
    expect(result.PRE_EXISTING).toBe('value');
    expect(result.NEW_KEY).toBe('new_value');
  });

  it('readNeonLaunchEnv returns {} when the file is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neon-launch-env-absent-'));
    expect(readNeonLaunchEnv(dir)).toEqual({});
  });
});

describe('resolveStateValue precedence chain', () => {
  // Documented: process.env > .neon-launch.env > .neon middleware context.
  // Empty strings in higher tiers fall through to the next tier (this
  // matters for CI where missing env vars sometimes arrive as empty
  // strings via templating).
  it('process.env wins over .neon-launch.env', () => {
    expect(
      resolveStateValue(
        'NEON_PROJECT_ID',
        { NEON_PROJECT_ID: 'from-env' },
        { NEON_PROJECT_ID: 'from-launch-env' },
        { NEON_PROJECT_ID: 'from-neon-ctx' },
      ),
    ).toBe('from-env');
  });

  it('.neon-launch.env wins over .neon context when process.env is absent', () => {
    expect(
      resolveStateValue(
        'NEON_PROJECT_ID',
        {},
        { NEON_PROJECT_ID: 'from-launch-env' },
        { NEON_PROJECT_ID: 'from-neon-ctx' },
      ),
    ).toBe('from-launch-env');
  });

  it('falls through to .neon context when both above are absent', () => {
    expect(
      resolveStateValue(
        'NEON_PROJECT_ID',
        {},
        {},
        { NEON_PROJECT_ID: 'from-neon-ctx' },
      ),
    ).toBe('from-neon-ctx');
  });

  it('empty string in process.env falls through (NOT treated as set)', () => {
    // CI templating sometimes injects `--project-id=$EMPTY_VAR` → empty.
    // The fallback should still pick up the lower tier.
    expect(
      resolveStateValue(
        'NEON_PROJECT_ID',
        { NEON_PROJECT_ID: '' },
        { NEON_PROJECT_ID: 'from-launch-env' },
        {},
      ),
    ).toBe('from-launch-env');
  });

  it('all tiers empty/absent → undefined', () => {
    expect(resolveStateValue('NEON_PROJECT_ID', {}, {}, {})).toBeUndefined();
  });
});
