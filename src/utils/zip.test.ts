import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { collectFiles, buildZip, zipBundle } from './zip';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'neonctl-zip-'));
  writeFileSync(join(dir, 'index.ts'), 'export default {};\n');
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'lib', 'util.ts'), 'export const x = 1;\n');
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git', 'config'), 'ignored\n');
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'ignored\n');
  symlinkSync(join(dir, 'index.ts'), join(dir, 'link.ts'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('zip', () => {
  test('collectFiles includes source, excludes .git/node_modules, skips symlinks', () => {
    const keys = Object.keys(collectFiles(dir)).sort();
    expect(keys).toEqual(['index.ts', 'lib/util.ts']);
  });

  test('buildZip produces an archive with index.ts at the root', () => {
    const entries = Object.keys(unzipSync(buildZip(dir))).sort();
    expect(entries).toEqual(['index.ts', 'lib/util.ts']);
  });

  test('zipBundle round-trips the given entries', () => {
    const entries: Record<string, Uint8Array> = {
      'out.js': new TextEncoder().encode('export default {};'),
      'out.js.map': new TextEncoder().encode('{"version":3}'),
    };
    const back = unzipSync(zipBundle(entries));
    expect(Object.keys(back).sort()).toEqual(['out.js', 'out.js.map']);
    expect(new TextDecoder().decode(back['out.js'])).toBe('export default {};');
  });
});
