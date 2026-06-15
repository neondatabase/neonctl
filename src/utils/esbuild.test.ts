import { describe, expect, test, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { strFromU8 } from 'fflate';
import { bundleEntry, type BundleDeps } from './esbuild';

const require = createRequire(import.meta.url);
// Absolute, CWD- and PATH-independent path to the esbuild CLI shipped with the
// dev checkout. Pinning NEON_ESBUILD_PATH to it makes the binary-path branch
// deterministic in tests.
const ESBUILD_BIN = require.resolve('esbuild/bin/esbuild');

// Explicit npm-mode deps: process.pkg undefined + real esbuild import. Passing
// these explicitly keeps these tests on the in-process module path even if a
// future test setup ever shimmed process.pkg.
const npmDeps: BundleDeps = {
  isPackaged: () => false,
  loadEsbuild: (name: string) => import(name),
};

const withEnv = async (
  value: string,
  fn: () => Promise<void>,
): Promise<void> => {
  const prev = process.env.NEON_ESBUILD_PATH;
  process.env.NEON_ESBUILD_PATH = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.NEON_ESBUILD_PATH;
    else process.env.NEON_ESBUILD_PATH = prev;
  }
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'neonctl-esbuild-'));
  writeFileSync(
    join(dir, 'helper.ts'),
    'export const greet = () => "hi from helper";\n',
  );
  writeFileSync(
    join(dir, 'index.ts'),
    [
      'import { greet } from "./helper";',
      'import { readFileSync } from "node:fs";',
      'export default { greet, readFileSync };',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'broken.ts'), 'export default {\n');
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('bundleEntry', () => {
  test('inlines local imports and emits no sourcemap', async () => {
    const out = await bundleEntry(join(dir, 'index.ts'), npmDeps);
    const js = strFromU8(out['index.mjs']);
    expect(js).toContain('hi from helper');
    expect(js).not.toContain('./helper');
    // No source map is generated — the Functions runtime never consumes it, so we neither
    // emit `index.mjs.map` nor leave a dangling `sourceMappingURL` link in the bundle.
    expect(js).not.toContain('sourceMappingURL');
    expect(out['index.mjs.map']).toBeUndefined();
  });

  // Node built-ins stay external on platform:'node'; the createRequire banner is injected
  // so bundled CommonJS deps can `require(...)` inside the ESM output.
  test('keeps node built-ins external and injects a createRequire banner', async () => {
    const js = strFromU8(
      (await bundleEntry(join(dir, 'index.ts'), npmDeps))['index.mjs'],
    );
    expect(js).toContain('node:fs');
    expect(js).toContain('createRequire');
  });

  test('surfaces a bundle error without falling back to a binary search', async () => {
    const source = join(dir, 'broken.ts');
    const err = (await bundleEntry(source, npmDeps).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toContain(`Failed to bundle function from ${source}`);
    expect(err.message).not.toContain('esbuild not found');
  });

  test('packaged mode uses the binary and never imports the esbuild module', async () => {
    const loadEsbuild = vi.fn(() =>
      Promise.reject(new Error('should not be called')),
    );
    await withEnv(ESBUILD_BIN, async () => {
      const out = await bundleEntry(join(dir, 'index.ts'), {
        isPackaged: () => true,
        loadEsbuild,
      });
      expect(loadEsbuild).not.toHaveBeenCalled();
      expect(strFromU8(out['index.mjs'])).toContain('hi from helper');
    });
  });

  test('falls back to the binary when the esbuild module cannot be imported', async () => {
    const loadEsbuild = vi.fn(() =>
      Promise.reject(new Error('Cannot find module esbuild')),
    );
    await withEnv(ESBUILD_BIN, async () => {
      const out = await bundleEntry(join(dir, 'index.ts'), {
        isPackaged: () => false,
        loadEsbuild,
      });
      expect(loadEsbuild).toHaveBeenCalledOnce();
      expect(strFromU8(out['index.mjs'])).toContain('hi from helper');
    });
  });

  test('prints install instructions when no esbuild can be found', async () => {
    const loadEsbuild = vi.fn(() =>
      Promise.reject(new Error('should not be called')),
    );
    await withEnv(join(dir, 'no-such-esbuild'), async () => {
      await expect(
        bundleEntry(join(dir, 'index.ts'), {
          isPackaged: () => true,
          loadEsbuild,
        }),
      ).rejects.toThrow('esbuild not found');
    });
  });
});
