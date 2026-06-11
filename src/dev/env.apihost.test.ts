import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolveNeonEnvVars forwards apiHost', () => {
  it('forwards ctx.apiHost into pullConfig (no neon.ts tier)', async () => {
    // A `.git` dir marks the temp dir as a repo root, so the config-file walk stops
    // there: no neon.ts is found and the resolver takes the pullConfig tier.
    const cwd = mkdtempSync(join(tmpdir(), 'neonctl-dev-'));
    mkdirSync(join(cwd, '.git'));
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
