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
      `neon_override_ctx_${Date.now()}`,
    );

    testCliCommand({
      name: 'get project id overrides context set project',
      before: async () => {
        writeFileSync(
          overrideContextFile,
          JSON.stringify({
            projectId: 'new-project id',
          }),
        );
      },
      after: async () => {
        rmSync(overrideContextFile);
      },
      args: [
        'project',
        'get',
        'project-id-123',
        '--context-file',
        overrideContextFile,
      ],
      expected: {
        snapshot: true,
      },
    });

    testCliCommand({
      name: 'set the branchId and projectId is from context',
      before: async () => {
        writeFileSync(
          overrideContextFile,
          JSON.stringify({
            projectId: 'test',
            branchId: 'test_branch',
          }),
        );
      },
      after: async () => {
        rmSync(overrideContextFile);
      },
      args: ['databases', 'list', '--context-file', overrideContextFile],
      expected: {
        snapshot: true,
      },
    });

    testCliCommand({
      name: 'should not set branchId from context for non-context projectId',
      before: async () => {
        writeFileSync(
          overrideContextFile,
          JSON.stringify({
            projectId: 'project-id-123',
            branchId: 'test_branch',
          }),
        );
      },
      after: async () => {
        rmSync(overrideContextFile);
      },
      args: [
        'databases',
        'list',
        '--project-id',
        'test',
        '--context-file',
        overrideContextFile,
      ],
      expected: {
        code: 1,
        stderr: 'ERROR: Not Found',
        snapshot: true,
      },
    });
  });
});
