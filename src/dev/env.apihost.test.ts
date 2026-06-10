import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@neondatabase/config-runtime', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@neondatabase/config-runtime')>();
  return {
    ...actual,
    pullConfig: vi.fn(() => {
      throw new Error('STOP');
    }),
  };
});

import { pullConfig } from '@neondatabase/config-runtime';
import { resolveNeonEnvVars } from './env.js';

const HOST = 'https://stage.example/api/v2';

afterEach(() => vi.clearAllMocks());

describe('resolveNeonEnvVars forwards apiHost', () => {
  it('forwards ctx.apiHost into pullConfig (no neon.ts tier)', async () => {
    // Invariant: a fresh /tmp dir has no neon.ts on the walk up to root (the loader
    // stops at $HOME, and /tmp is not under $HOME), so resolveNeonEnvVars takes the
    // pullConfig tier. A stray /tmp/neon.ts or /neon.ts would flip the tier.
    const cwd = mkdtempSync(`${tmpdir()}/neonctl-dev-`);
    try {
      await expect(
        resolveNeonEnvVars({
          cwd,
          projectId: 'p',
          branchId: 'br-1',
          apiKey: 'k',
          apiHost: HOST,
        }),
      ).rejects.toThrow('STOP');
      expect(pullConfig).toHaveBeenCalledWith(
        expect.objectContaining({ apiHost: HOST }),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
