/**
 * buildLaunchContext — flag extraction + normalization.
 *
 * The boolean-string normalization is the contract the example demo
 * relies on (`flags.prod === true` for both `--prod` and `--prod=true`).
 * Without these tests a future refactor of `buildLaunchContext` could
 * silently drop the normalization and the example would compile + run
 * but fall through to the local-dev branch when the user expected prod.
 */
import { describe, it, expect } from 'vitest';

import { buildLaunchContext } from './context.js';

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

  it("string 'true' normalizes to boolean true", () => {
    expect(ctx({ prod: 'true' }).flags.prod).toBe(true);
  });

  it("string 'false' normalizes to boolean false", () => {
    expect(ctx({ prod: 'false' }).flags.prod).toBe(false);
  });

  it('non-boolean strings pass through unchanged', () => {
    expect(ctx({ mode: 'staging' }).flags.mode).toBe('staging');
  });

  it('numbers pass through unchanged', () => {
    expect(ctx({ port: 8080 }).flags.port).toBe(8080);
  });

  it('recognized flags are not exposed on ctx.flags', () => {
    expect(ctx({ config: './neon.ts' }).flags.config).toBeUndefined();
  });

  it('yargs internals are skipped', () => {
    const result = ctx({ _: [], '--': [], $0: 'neon' });
    expect(result.flags._).toBeUndefined();
    expect(result.flags['--']).toBeUndefined();
    expect(result.flags.$0).toBeUndefined();
  });
});
