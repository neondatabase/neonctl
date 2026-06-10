import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@neondatabase/config-runtime', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@neondatabase/config-runtime')>();
  return {
    ...actual,
    inspect: vi.fn(() => {
      throw new Error('STOP');
    }),
    plan: vi.fn(() => {
      throw new Error('STOP');
    }),
    apply: vi.fn(() => {
      throw new Error('STOP');
    }),
    createBranch: vi.fn(() => {
      throw new Error('STOP');
    }),
  };
});

vi.mock('../utils/enrichers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/enrichers.js')>();
  return {
    ...actual,
    branchIdFromProps: vi.fn(() => Promise.resolve('br-test')),
  };
});

import {
  apply,
  createBranch,
  inspect,
  plan,
} from '@neondatabase/config-runtime';
import type { ConfigProps } from './config.js';
import {
  applyCmd,
  applyPolicyOnCreate,
  createBranchFromPolicyOnCheckout,
  planCmd,
  status,
} from './config.js';

const HOST = 'https://stage.example/api/v2';

const baseProps = (): ConfigProps => ({
  apiClient: {} as ConfigProps['apiClient'],
  apiKey: '',
  apiHost: HOST,
  contextFile: '',
  output: 'json',
  projectId: 'p',
  branch: 'main',
});

afterEach(() => {
  vi.clearAllMocks();
});

const withNeonTs = async (run: (cwd: string) => Promise<void>) => {
  const cwd = mkdtempSync(join(tmpdir(), 'neonctl-cfg-'));
  writeFileSync(
    join(cwd, 'neon.ts'),
    `export default { branch() { return {}; } };\n`,
  );
  try {
    await run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

describe('config handlers forward apiHost', () => {
  it('status forwards apiHost into inspect', async () => {
    await expect(status(baseProps())).rejects.toThrow('STOP');
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ apiHost: HOST }),
    );
  });

  it('planCmd forwards apiHost into plan', async () => {
    await withNeonTs(async (cwd) => {
      await expect(
        planCmd({ ...baseProps(), config: join(cwd, 'neon.ts') }),
      ).rejects.toThrow('STOP');
      expect(plan).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ apiHost: HOST }),
      );
    });
  });

  it('applyCmd forwards apiHost into apply', async () => {
    await withNeonTs(async (cwd) => {
      await expect(
        applyCmd({ ...baseProps(), config: join(cwd, 'neon.ts') }),
      ).rejects.toThrow('STOP');
      expect(apply).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ apiHost: HOST }),
      );
    });
  });

  it('applyPolicyOnCreate forwards apiHost into apply', async () => {
    await withNeonTs(async (cwd) => {
      await expect(
        applyPolicyOnCreate({
          projectId: 'p',
          branchId: 'br-test',
          apiHost: HOST,
          cwd,
        }),
      ).rejects.toThrow('STOP');
      expect(apply).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ apiHost: HOST }),
      );
    });
  });

  it('createBranchFromPolicyOnCheckout forwards apiHost into createBranch', async () => {
    await withNeonTs(async (cwd) => {
      await expect(
        createBranchFromPolicyOnCheckout({
          projectId: 'p',
          branchName: 'feature-x',
          apiHost: HOST,
          cwd,
        }),
      ).rejects.toThrow('STOP');
      expect(createBranch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ apiHost: HOST }),
      );
    });
  });
});
