import { fork } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect } from 'vitest';

import { test as originalTest } from '../test_utils/fixtures';

// All tests in this file share a single temporary directory whose path is
// normalized in snapshots to `<TMP>` so that absolute paths in command output
// (both human summaries and agent JSON) remain stable across runs and machines.
const TEST_TMP = mkdtempSync(join(tmpdir(), 'neonctl-link-'));

const TMP_TOKEN = '<TMP>';

beforeAll(() => {
  // Replace any reference to the per-run tmp directory with a stable token so
  // snapshots only carry the deterministic suffix portion of paths.
  expect.addSnapshotSerializer({
    test: (val) => typeof val === 'string' && val.includes(TEST_TMP),
    serialize: (val, config, indentation, depth, refs, printer) =>
      printer(
        (val as string).split(TEST_TMP).join(TMP_TOKEN),
        config,
        indentation,
        depth,
        refs,
      ),
  });
});

const test = originalTest.extend<{
  cleanupFile: (name: string) => void;
  readFile: (name: string) => string;
  removeFile: (name: string) => void;
  tmpContext: (label: string) => string;
  runLinkInCi: (args: string[]) => Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>;
}>({
  // eslint-disable-next-line no-empty-pattern
  cleanupFile: async ({}, use) => {
    let writtenFilename: string | undefined;
    await use((name) => (writtenFilename = name));
    if (writtenFilename) {
      try {
        rmSync(writtenFilename);
      } catch {
        // ignore
      }
    }
  },
  readFile: async ({ cleanupFile }, use) => {
    await use((name) => {
      const content = readFileSync(name, 'utf-8');
      cleanupFile(name);
      return content;
    });
  },
  // eslint-disable-next-line no-empty-pattern
  removeFile: async ({}, use) => {
    await use((name) => {
      try {
        rmSync(name);
      } catch {
        // ignore
      }
    });
  },
  // Each test gets its OWN sub-directory under TEST_TMP so the
  // `.gitignore` scaffolded next to the `.neon` written by one test doesn't
  // affect another test in the same file.
  // eslint-disable-next-line no-empty-pattern
  tmpContext: async ({}, use) => {
    await use((label) => {
      const dir = join(TEST_TMP, label);
      mkdirSync(dir, { recursive: true });
      return join(dir, '.neon');
    });
  },
  runLinkInCi: async ({ runMockServer }, use) => {
    await use(async (args) => {
      const server = await runMockServer('main');
      const port = (server.address() as AddressInfo).port;
      return new Promise((resolve, reject) => {
        const cp = fork(
          join(process.cwd(), './dist/index.js'),
          [
            '--api-host',
            `http://localhost:${port}`,
            '--output',
            'yaml',
            '--api-key',
            'test-key',
            '--no-analytics',
            ...args,
          ],
          {
            stdio: 'pipe',
            env: {
              PATH: `mocks/bin:${process.env.PATH}`,
              CI: 'true',
            },
          },
        );
        let stdout = '';
        let stderr = '';
        cp.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        cp.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        cp.on('error', reject);
        cp.on('close', (code) => {
          resolve({ code: code ?? -1, stdout, stderr });
        });
      });
    });
  },
});

describe('link', () => {
  describe('non-interactive flag mode', () => {
    test('link to existing project writes .neon with default branch id', async ({
      testCliCommand,
      readFile,
      tmpContext,
    }) => {
      const ctx = tmpContext('flag_existing');
      await testCliCommand([
        'link',
        '--org-id',
        'org-2',
        '--project-id',
        'test',
        '--context-file',
        ctx,
      ]);
      expect(readFile(ctx)).toMatchSnapshot();
    });

    test('link with --params JSON behaves like flags', async ({
      testCliCommand,
      readFile,
      tmpContext,
    }) => {
      const ctx = tmpContext('flag_params');
      await testCliCommand([
        'link',
        '--params',
        JSON.stringify({ orgId: 'org-2', projectId: 'test' }),
        '--context-file',
        ctx,
      ]);
      expect(readFile(ctx)).toMatchSnapshot();
    });

    test('link creates a new project and writes .neon', async ({
      testCliCommand,
      readFile,
      tmpContext,
    }) => {
      const ctx = tmpContext('flag_create');
      await testCliCommand([
        'link',
        '--org-id',
        'org-2',
        '--project-name',
        'test_project',
        '--region-id',
        'aws-us-east-2',
        '--context-file',
        ctx,
      ]);
      expect(readFile(ctx)).toMatchSnapshot();
    });

    test('conflicting inputs (--project-id with --project-name) fails', async ({
      testCliCommand,
      tmpContext,
    }) => {
      await testCliCommand(
        [
          'link',
          '--org-id',
          'org-2',
          '--project-id',
          'test',
          '--project-name',
          'test_project',
          '--context-file',
          tmpContext('flag_conflict'),
        ],
        {
          code: 1,
          stderr:
            'ERROR: Conflicting inputs: --project-id selects an existing project; --project-name and --region-id describe a new one. Pass only one set.',
        },
      );
    });
  });

  describe('--agent mode', () => {
    test('with no flags emits needs_org JSON', async ({
      testCliCommand,
      removeFile,
      tmpContext,
    }) => {
      const ctx = tmpContext('agent_needs_org');
      await testCliCommand(['link', '--agent', '--context-file', ctx]);
      removeFile(ctx);
    });

    test('with only --org-id emits needs_project JSON', async ({
      testCliCommand,
      removeFile,
      tmpContext,
    }) => {
      const ctx = tmpContext('agent_needs_project');
      await testCliCommand([
        'link',
        '--agent',
        '--org-id',
        'org-2',
        '--context-file',
        ctx,
      ]);
      removeFile(ctx);
    });

    test('with org+project emits linked JSON and writes .neon', async ({
      testCliCommand,
      readFile,
      tmpContext,
    }) => {
      const ctx = tmpContext('agent_linked_existing');
      await testCliCommand([
        'link',
        '--agent',
        '--org-id',
        'org-2',
        '--project-id',
        'test',
        '--context-file',
        ctx,
      ]);
      expect(readFile(ctx)).toMatchSnapshot();
    });

    test('with org+projectName but no region emits needs_project_details JSON', async ({
      testCliCommand,
      removeFile,
      tmpContext,
    }) => {
      const ctx = tmpContext('agent_needs_region');
      await testCliCommand([
        'link',
        '--agent',
        '--org-id',
        'org-2',
        '--project-name',
        'demo',
        '--context-file',
        ctx,
      ]);
      removeFile(ctx);
    });

    test('with full project details creates project and emits linked JSON', async ({
      testCliCommand,
      readFile,
      tmpContext,
    }) => {
      const ctx = tmpContext('agent_linked_create');
      await testCliCommand([
        'link',
        '--agent',
        '--org-id',
        'org-2',
        '--project-name',
        'test_project',
        '--region-id',
        'aws-us-east-2',
        '--context-file',
        ctx,
      ]);
      expect(readFile(ctx)).toMatchSnapshot();
    });
  });

  describe('org-scoped API key behavior', () => {
    test('agent mode with no orgs available and no projects emits orgKeyLimited needs_org', async ({
      testCliCommand,
      removeFile,
      tmpContext,
    }) => {
      const ctx = tmpContext('orgkey_empty');
      await testCliCommand(['link', '--agent', '--context-file', ctx], {
        mockDir: 'org-key-empty',
      });
      removeFile(ctx);
    });

    test('agent mode auto-detects org from existing projects when org listing is forbidden', async ({
      testCliCommand,
      removeFile,
      tmpContext,
    }) => {
      const ctx = tmpContext('orgkey_autodetect');
      await testCliCommand(['link', '--agent', '--context-file', ctx], {
        mockDir: 'org-key',
      });
      removeFile(ctx);
    });

    test('agent mode falls back to static regions when getActiveRegions is forbidden', async ({
      testCliCommand,
      removeFile,
      tmpContext,
    }) => {
      const ctx = tmpContext('orgkey_regions_fallback');
      await testCliCommand(
        [
          'link',
          '--agent',
          '--org-id',
          'org-detected-99887766',
          '--project-name',
          'whatever',
          '--context-file',
          ctx,
        ],
        { mockDir: 'org-key' },
      );
      removeFile(ctx);
    });
  });

  describe('agent error responses', () => {
    test('invalid --params JSON yields error JSON, exit 1', async ({
      runLinkInCi,
      tmpContext,
    }) => {
      const result = await runLinkInCi([
        'link',
        '--agent',
        '--params',
        'not-valid-json',
        '--context-file',
        tmpContext('agent_bad_params'),
      ]);
      expect(result.code).toBe(1);
      const parsed = JSON.parse(result.stdout) as {
        status: string;
        code: string;
        message: string;
      };
      expect(parsed.status).toBe('error');
      expect(parsed.code).toBe('INTERNAL_ERROR');
      expect(parsed.message).toContain('Failed to parse --params JSON');
    });

    test('conflicting flags in agent mode yields error JSON, exit 1', async ({
      runLinkInCi,
      tmpContext,
    }) => {
      const result = await runLinkInCi([
        'link',
        '--agent',
        '--org-id',
        'org-2',
        '--project-id',
        'test',
        '--project-name',
        'x',
        '--context-file',
        tmpContext('agent_conflict'),
      ]);
      expect(result.code).toBe(1);
      const parsed = JSON.parse(result.stdout) as {
        status: string;
        code: string;
        message: string;
      };
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('Conflicting inputs');
    });
  });

  describe('CI guard', () => {
    test('errors out with helpful message when no inputs provided in CI', async ({
      runLinkInCi,
      tmpContext,
    }) => {
      const result = await runLinkInCi([
        'link',
        '--context-file',
        tmpContext('ci_guard'),
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('CI environment detected');
      expect(result.stderr).toContain('neonctl link --agent');
    });
  });

  describe('set-context regression', () => {
    test('set-context --branch-id writes branchId to .neon', async ({
      testCliCommand,
      readFile,
      tmpContext,
    }) => {
      const ctx = tmpContext('sc_branch');
      await testCliCommand([
        'set-context',
        '--project-id',
        'test_project',
        '--branch-id',
        'br-main-branch-123456',
        '--context-file',
        ctx,
      ]);
      expect(readFile(ctx)).toMatchSnapshot();
    });
  });

  test('overwrites an existing .neon when re-linking non-interactively', async ({
    testCliCommand,
    readFile,
    tmpContext,
  }) => {
    const ctx = tmpContext('overwrite');
    writeFileSync(
      ctx,
      JSON.stringify({ orgId: 'old', projectId: 'old', branchId: 'old' }),
    );
    await testCliCommand([
      'link',
      '--org-id',
      'org-2',
      '--project-id',
      'test',
      '--context-file',
      ctx,
    ]);
    expect(readFile(ctx)).toMatchSnapshot();
  });

  describe('gitignore scaffolding', () => {
    test('creates a .gitignore listing .neon next to the context file', async ({
      testCliCommand,
      tmpContext,
    }) => {
      const ctx = tmpContext('gi_creates');
      await testCliCommand([
        'link',
        '--org-id',
        'org-2',
        '--project-id',
        'test',
        '--context-file',
        ctx,
      ]);
      const giPath = join(ctx, '..', '.gitignore');
      expect(readFileSync(giPath, 'utf-8')).toBe('.neon\n');
    });

    test('appends .neon to an existing .gitignore without duplicating', async ({
      testCliCommand,
      tmpContext,
    }) => {
      const ctx = tmpContext('gi_appends');
      const giPath = join(ctx, '..', '.gitignore');
      writeFileSync(giPath, 'node_modules\ndist\n');
      await testCliCommand([
        'link',
        '--org-id',
        'org-2',
        '--project-id',
        'test',
        '--context-file',
        ctx,
      ]);
      expect(readFileSync(giPath, 'utf-8')).toBe('node_modules\ndist\n.neon\n');

      // Re-link in the same dir must not produce a duplicate entry.
      await testCliCommand([
        'link',
        '--org-id',
        'org-2',
        '--project-id',
        'test',
        '--context-file',
        ctx,
      ]);
      expect(readFileSync(giPath, 'utf-8')).toBe('node_modules\ndist\n.neon\n');
    });

    test('set-context also scaffolds .gitignore via the shared applyContext', async ({
      testCliCommand,
      tmpContext,
    }) => {
      const ctx = tmpContext('gi_set_context');
      await testCliCommand([
        'set-context',
        '--project-id',
        'test',
        '--context-file',
        ctx,
      ]);
      const giPath = join(ctx, '..', '.gitignore');
      expect(readFileSync(giPath, 'utf-8')).toBe('.neon\n');
    });
  });
});
