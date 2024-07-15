import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { describe, expect } from 'vitest';

import { test as originalTest } from '../test_utils/fixtures';

const CONTEXT_FILE = join(tmpdir(), `neon_${Date.now()}`);

const test = originalTest.extend<{
  cleanupFile: (name: string) => void;
  writeFile: (name: string, content: unknown) => void;
  readFile: (name: string) => string;
}>({
  // eslint-disable-next-line no-empty-pattern
  cleanupFile: async ({}, use) => {
    let writtenFilename: string | undefined;
    await use((name) => (writtenFilename = name));
    if (writtenFilename) {
      rmSync(writtenFilename);
    }
  },
  writeFile: async ({ cleanupFile }, use) => {
    await use((name, content) => {
      writeFileSync(name, JSON.stringify(content));
      cleanupFile(name);
    });
  },
  readFile: async ({ cleanupFile }, use) => {
    await use((name) => {
      const content = readFileSync(name, 'utf-8');
      cleanupFile(name);
      return content;
    });
  },
});

describe('set_context', () => {
  describe('should set the context', () => {
    test('set-context', async ({ testCliCommand, readFile }) => {
      await testCliCommand([
        'set-context',
        '--project-id',
        'test',
        '--context-file',
        CONTEXT_FILE,
      ]);
      expect(readFile(CONTEXT_FILE)).toMatchSnapshot();
    });

    test('list branches selecting project from the context', async ({
      testCliCommand,
      writeFile,
    }) => {
      writeFile(CONTEXT_FILE, {
        projectId: 'test',
      });
      await testCliCommand([
        'branches',
        'list',
        '--context-file',
        CONTEXT_FILE,
      ]);
    });

    const overrideContextFile = join(
      tmpdir(),
      `neon_override_ctx_${Date.now()}`,
    );

    test('get project id overrides context set project', async ({
      testCliCommand,
      writeFile,
    }) => {
      writeFile(overrideContextFile, {
        projectId: 'new-project id',
      });
      await testCliCommand([
        'project',
        'get',
        'project-id-123',
        '--context-file',
        overrideContextFile,
      ]);
    });

    test('set the branchId and projectId is from context', async ({
      testCliCommand,
      writeFile,
    }) => {
      writeFile(overrideContextFile, {
        projectId: 'test',
        branchId: 'test_branch',
      });
      await testCliCommand([
        'databases',
        'list',
        '--context-file',
        overrideContextFile,
      ]);
    });

    test('set the branchId and projectId is from context', async ({
      testCliCommand,
      writeFile,
    }) => {
      writeFile(overrideContextFile, {
        projectId: 'project-id-123',
        branchId: 'test_branch',
      });
      await testCliCommand(
        [
          'databases',
          'list',
          '--project-id',
          'test',
          '--context-file',
          overrideContextFile,
        ],
        {
          code: 1,
          stderr: 'ERROR: Not Found',
        },
      );
    });
  });
});
