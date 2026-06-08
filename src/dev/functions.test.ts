import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveFunctionsFromConfig } from './functions.js';

/**
 * Write a neon.ts and the function source files it references into a temp dir, so
 * resolveFunctionsFromConfig (which loads + resolves the policy and checks each source
 * exists on disk) runs against a realistic layout.
 */
const writeWorkspace = (
  cwd: string,
  neonTs: string,
  sources: string[],
): void => {
  writeFileSync(join(cwd, 'neon.ts'), neonTs);
  for (const rel of sources) {
    writeFileSync(
      join(cwd, rel),
      'export default { fetch: () => new Response("ok") };\n',
    );
  }
};

describe('resolveFunctionsFromConfig', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'neonctl-dev-fns-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('returns null when there is no neon.ts', async () => {
    await expect(resolveFunctionsFromConfig(cwd)).resolves.toBeNull();
  });

  it('returns an empty list when neon.ts declares no functions', async () => {
    writeWorkspace(cwd, 'export default () => ({});\n', []);
    await expect(resolveFunctionsFromConfig(cwd)).resolves.toEqual([]);
  });

  it('resolves each function with an absolute source and its dev settings', async () => {
    writeWorkspace(
      cwd,
      `export default () => ({
        preview: {
          functions: [
            { slug: 'hello', name: 'Hello', source: './hello.ts', dev: { port: 8788 } },
            { slug: 'api', name: 'Api', source: './api.ts', dev: { portless: true } },
            { slug: 'bare', name: 'Bare', source: './bare.ts' },
          ],
        },
      });\n`,
      ['hello.ts', 'api.ts', 'bare.ts'],
    );

    const fns = await resolveFunctionsFromConfig(cwd);
    expect(fns).not.toBeNull();
    const bySlug = Object.fromEntries((fns ?? []).map((f) => [f.slug, f]));

    expect(bySlug.hello).toMatchObject({
      slug: 'hello',
      name: 'Hello',
      source: join(cwd, 'hello.ts'),
      port: 8788,
      portless: false,
    });
    expect(bySlug.api).toMatchObject({
      slug: 'api',
      source: join(cwd, 'api.ts'),
      portless: true,
    });
    // portless function gets no port (portless assigns it).
    expect(bySlug.api.port).toBeUndefined();
    // bare function: no port, not portless.
    expect(bySlug.bare.portless).toBe(false);
    expect(bySlug.bare.port).toBeUndefined();
  });

  it('throws when a declared function source does not exist on disk', async () => {
    writeWorkspace(
      cwd,
      `export default () => ({
        preview: { functions: [{ slug: 'gone', name: 'Gone', source: './missing.ts' }] },
      });\n`,
      [],
    );
    await expect(resolveFunctionsFromConfig(cwd)).rejects.toThrow(
      /source that does not exist/,
    );
  });

  it('carries per-function env through', async () => {
    writeWorkspace(
      cwd,
      `export default () => ({
        preview: {
          functions: [
            { slug: 'e', name: 'E', source: './e.ts', env: { FOO: 'bar' } },
          ],
        },
      });\n`,
      ['e.ts'],
    );
    const fns = await resolveFunctionsFromConfig(cwd);
    expect(fns?.[0].env).toEqual({ FOO: 'bar' });
  });
});
