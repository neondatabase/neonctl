import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../dev/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dev/env.js')>();
  return {
    ...actual,
    resolveNeonEnvVars: vi.fn(() => Promise.resolve({})),
  };
});

vi.mock('../utils/enrichers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/enrichers.js')>();
  return {
    ...actual,
    branchIdFromProps: vi.fn(() => Promise.resolve('br-test')),
  };
});

import { resolveNeonEnvVars } from '../dev/env.js';
import { pull, type EnvPullProps } from './env.js';

const HOST = 'https://stage.example/api/v2';

afterEach(() => {
  vi.clearAllMocks();
});

describe('env pull wires apiHost into the resolver context', () => {
  it('passes props.apiHost as ctx.apiHost', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'neonctl-envpull-'));
    try {
      const props: EnvPullProps = {
        apiClient: {} as never,
        apiKey: '',
        apiHost: HOST,
        output: 'table',
        contextFile: '',
        projectId: 'p',
        branch: 'main',
        cwd,
      };
      await pull(props);
      expect(resolveNeonEnvVars).toHaveBeenCalledWith(
        expect.objectContaining({ apiHost: HOST }),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
