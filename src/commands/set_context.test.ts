import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { afterAll, describe } from '@jest/globals';
import { testCliCommand } from '../test_utils/test_cli_command';

const CONTEXT_FILE = join(tmpdir(), `neon_${Date.now()}`);

describe('set_context', () => {
  afterAll(() => {
    rmSync(CONTEXT_FILE);
  });

  describe('should set the context', () => {
    testCliCommand({
      name: 'set-context',
      args: [
        'set-context',
        '--project-id',
        'test',
        '--context-file',
        CONTEXT_FILE,
      ],
    });

    testCliCommand({
      name: 'list branches selecting project from the context',
      args: ['branches', 'list', '--context-file', CONTEXT_FILE],
      expected: {
        snapshot: true,
      },
    });

    const overrideContextFile = join(
      tmpdir(),
      `neon_override_ctx_${Date.now()}`
    );
    testCliCommand({
      name: 'get branch id overrides context set branch',
      before: async () => {
        writeFileSync(
          overrideContextFile,
          JSON.stringify({
            projectId: 'test',
            branchId: 'br-cloudy-branch-12345678',
          })
        );
      },
      after: async () => {
        rmSync(overrideContextFile);
      },
      args: [
        'branches',
        'get',
        'br-sunny-branch-123456',
        '--context-file',
        overrideContextFile,
      ],
      expected: {
        snapshot: true,
      },
    });
  });
});
