import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8 } from 'fflate';
import { bundleEntry } from './esbuild';

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
      'import "neon-fake-external-pkg";',
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
  test('inlines local imports and emits a sourcemap', async () => {
    const out = await bundleEntry(join(dir, 'index.ts'));
    const js = strFromU8(out['out.js']);
    expect(js).toContain('hi from helper');
    expect(js).not.toContain('./helper');
    expect(out['out.js.map'].length).toBeGreaterThan(0);
  });

  // --packages=external leaves ALL bare imports external, not just built-ins.
  test('leaves bare imports (node built-ins and npm packages) external', async () => {
    const js = strFromU8((await bundleEntry(join(dir, 'index.ts')))['out.js']);
    expect(js).toContain('node:fs');
    expect(js).toContain('neon-fake-external-pkg');
  });

  test('throws a clean error naming the source on a syntax error', async () => {
    const source = join(dir, 'broken.ts');
    await expect(bundleEntry(source)).rejects.toThrow(
      `Failed to bundle function from ${source}`,
    );
  });

  test('throws not-found when NEON_ESBUILD_PATH points nowhere', async () => {
    const prev = process.env.NEON_ESBUILD_PATH;
    process.env.NEON_ESBUILD_PATH = join(dir, 'no-such-esbuild');
    try {
      await expect(bundleEntry(join(dir, 'index.ts'))).rejects.toThrow(
        'esbuild not found',
      );
    } finally {
      if (prev === undefined) delete process.env.NEON_ESBUILD_PATH;
      else process.env.NEON_ESBUILD_PATH = prev;
    }
  });
});
