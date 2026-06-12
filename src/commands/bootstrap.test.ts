import { fork } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

// A fixture file in the template repo: its git `mode` decides whether it lands
// as a regular file, an executable, or a symlink (whose content is the target).
type FixtureFile = { mode: string; content: string };

// Keyed by full repo path. The `with-hono` subdir mirrors what the real `hono`
// template uses; `with-remix/...` must be filtered out as a sibling example.
const FIXTURE: Record<string, FixtureFile> = {
  'with-hono/package.json': {
    mode: '100644',
    content: '{\n  "name": "with-hono"\n}\n',
  },
  'with-hono/src/index.ts': {
    mode: '100644',
    content: 'export const app = "hono";\n',
  },
  'with-hono/scripts/run.sh': {
    mode: '100755',
    content: '#!/bin/sh\necho hi\n',
  },
  // A symlink: in git the blob content is the (relative) link target.
  'with-hono/.claude/skills/neon': {
    mode: '120000',
    content: '../../package.json',
  },
  'with-remix/package.json': {
    mode: '100644',
    content: '{ "name": "with-remix" }\n',
  },
};

const COMMIT_SHA = 'commit0000000000000000000000000000000000';
const TREE_SHA = 'tree00000000000000000000000000000000000000';

const MANIFEST_YAML = `templates:
  - id: hono
    title: "Hono API (Drizzle, Neon Postgres) on Neon Functions"
    description: "A Hono API using Drizzle ORM and Neon Postgres, ready to deploy as a Neon Function."
    services:
      - Postgres
      - Functions
    source:
      owner: neondatabase
      repo: examples
      ref: main
      subdir: with-hono
`;

// A real local HTTP server standing in for the GitHub API + raw host, so the
// whole download/extract path runs end to end with no mocking of our own code.
const startGithubFixtureServer = (): Promise<Server> => {
  const app = express();

  // Serve the bootstrap manifest
  app.get('/manifest/bootstrap.yaml', (_req, res) => {
    res.type('text/yaml').send(MANIFEST_YAML);
  });

  app.get('/repos/:owner/:repo/commits/:ref', (_req, res) => {
    res.json({ sha: COMMIT_SHA, commit: { tree: { sha: TREE_SHA } } });
  });

  app.get('/repos/:owner/:repo/git/trees/:treeSha', (_req, res) => {
    const tree = Object.entries(FIXTURE).map(([path, file]) => ({
      path,
      mode: file.mode,
      type: 'blob',
    }));
    res.json({ sha: TREE_SHA, truncated: false, tree });
  });

  app.get('/raw/:owner/:repo/:sha/*', (req, res) => {
    const { owner, repo, sha } = req.params;
    const repoPath = decodeURIComponent(
      req.path.slice(`/raw/${owner}/${repo}/${sha}/`.length),
    );
    const file = FIXTURE[repoPath];
    if (!file) {
      res.status(404).send('Not Found');
      return;
    }
    res.type('application/octet-stream').send(Buffer.from(file.content));
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve(server);
    });
  });
};

const runBootstrap = (
  server: Server,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return new Promise((resolve, reject) => {
    const cp = fork(
      join(process.cwd(), './dist/index.js'),
      [
        'bootstrap',
        ...args,
        '--api-key',
        'test-key',
        '--no-analytics',
        '--output',
        'yaml',
      ],
      {
        stdio: 'pipe',
        env: {
          ...process.env,
          CI: 'true',
          NEON_BOOTSTRAP_GITHUB_API: base,
          NEON_BOOTSTRAP_GITHUB_RAW: `${base}/raw`,
          NEON_BOOTSTRAP_MANIFEST_URL: `${base}/manifest/bootstrap.yaml`,
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
};

// `--agent` writes a single JSON state-machine object to stdout (logs go to
// stderr), so the structured output stays machine-parseable.
const parseAgentOutput = (stdout: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(stdout.trim());
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Expected a JSON object, got: ${stdout}`);
  }
  return parsed as Record<string, unknown>;
};

describe('bootstrap', () => {
  let server: Server;
  let dest: string;

  beforeEach(async () => {
    server = await startGithubFixtureServer();
    dest = mkdtempSync(join(tmpdir(), 'neonctl-bootstrap-'));
  });

  afterEach(async () => {
    rmSync(dest, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });

  test('copies the template subtree, preserving files, exec bits, and symlinks', async () => {
    const { code, stderr } = await runBootstrap(server, [
      dest,
      '--template',
      'hono',
      '--force',
    ]);
    expect(code, stderr).toBe(0);

    // Regular + nested files are written with the subdir prefix stripped.
    expect(readFileSync(join(dest, 'package.json'), 'utf8')).toBe(
      '{\n  "name": "with-hono"\n}\n',
    );
    expect(readFileSync(join(dest, 'src/index.ts'), 'utf8')).toBe(
      'export const app = "hono";\n',
    );

    // The executable bit survives the round-trip.
    expect(lstatSync(join(dest, 'scripts/run.sh')).mode & 0o111).not.toBe(0);

    // The symlink is recreated as a real symlink pointing at its target.
    const link = join(dest, '.claude/skills/neon');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('../../package.json');

    // A sibling example in the same repo must not leak into the copy.
    expect(() => readFileSync(join(dest, 'with-remix/package.json'))).toThrow();
  });

  test('refuses a non-empty directory without --force', async () => {
    writeFileSync(join(dest, 'keep.txt'), 'mine\n');
    const { code, stderr } = await runBootstrap(server, [
      dest,
      '--template',
      'hono',
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain('not empty');
    // The existing file is left untouched and nothing was scaffolded.
    expect(readFileSync(join(dest, 'keep.txt'), 'utf8')).toBe('mine\n');
    expect(() => readFileSync(join(dest, 'package.json'))).toThrow();
  });

  test('rejects an unknown template id', async () => {
    const { code, stderr } = await runBootstrap(server, [
      dest,
      '--template',
      'does-not-exist',
      '--force',
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain('Unknown template');
  });

  test('--list prints available templates to stdout from the remote manifest', async () => {
    const { code, stdout, stderr } = await runBootstrap(server, ['--list']);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain('hono');
    expect(stdout).toContain('A Hono API using Drizzle ORM and Neon Postgres');
    // The services from the manifest are surfaced alongside each template.
    expect(stdout).toContain('[Postgres · Functions]');
  });

  test('--default scaffolds and inits git without prompting', async () => {
    // --no-install keeps the test offline/fast; git init still runs.
    const { code, stderr } = await runBootstrap(server, [
      dest,
      '--default',
      '--no-install',
      '--force',
    ]);
    expect(code, stderr).toBe(0);

    // The default template was scaffolded with no template/dir prompt.
    expect(readFileSync(join(dest, 'package.json'), 'utf8')).toBe(
      '{\n  "name": "with-hono"\n}\n',
    );
    // git init ran as part of the quick start.
    expect(existsSync(join(dest, '.git'))).toBe(true);
  });

  describe('--agent (JSON state machine)', () => {
    test('asks for a template when none is given', async () => {
      const { code, stdout, stderr } = await runBootstrap(server, ['--agent']);
      expect(code, stderr).toBe(0);
      const res = parseAgentOutput(stdout);
      expect(res.status).toBe('needs_template');
      // Options come from the remote manifest, including the services list.
      expect(res.options).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'hono',
            services: ['Postgres', 'Functions'],
          }),
        ]),
      );
      expect(res.next_command_template).toContain('--template <template_id>');
    });

    test('asks for a directory when only the template is given', async () => {
      const { code, stdout, stderr } = await runBootstrap(server, [
        '--agent',
        '--template',
        'hono',
      ]);
      expect(code, stderr).toBe(0);
      const res = parseAgentOutput(stdout);
      expect(res.status).toBe('needs_directory');
      expect(res.next_command_template).toContain('<directory>');
      expect(res.next_command_template).toContain('--template hono');
    });

    test('scaffolds and returns the install + git + link next steps', async () => {
      const { code, stdout, stderr } = await runBootstrap(server, [
        '--agent',
        dest,
        '--template',
        'hono',
        '--force',
      ]);
      expect(code, stderr).toBe(0);
      const res = parseAgentOutput(stdout);
      expect(res.status).toBe('scaffolded');
      expect(res.template).toEqual({
        id: 'hono',
        title: expect.any(String),
      });
      expect(res.files_written).toBeGreaterThan(0);

      // The files really landed on disk (end to end, no mocks).
      expect(readFileSync(join(dest, 'package.json'), 'utf8')).toBe(
        '{\n  "name": "with-hono"\n}\n',
      );

      // All follow-ups come back as structured, runnable next steps.
      const steps = res.next_steps as Record<string, unknown>[];
      const actions = steps.map((step) => step.action);
      expect(actions).toEqual([
        'install_dependencies',
        'initialize_git',
        'link_neon_project',
      ]);
      expect(steps[0].command).toContain('npm install');
      expect(steps[1].command).toContain('git init');
      expect(steps[2].command).toContain('neon link --agent');
    });

    test('errors with UNKNOWN_TEMPLATE for a bad template id', async () => {
      const { code, stdout } = await runBootstrap(server, [
        '--agent',
        dest,
        '--template',
        'does-not-exist',
        '--force',
      ]);
      expect(code).toBe(1);
      const res = parseAgentOutput(stdout);
      expect(res.status).toBe('error');
      expect(res.code).toBe('UNKNOWN_TEMPLATE');
    });

    test('errors with TARGET_NOT_EMPTY when the directory is not empty', async () => {
      writeFileSync(join(dest, 'keep.txt'), 'mine\n');
      const { code, stdout } = await runBootstrap(server, [
        '--agent',
        dest,
        '--template',
        'hono',
      ]);
      expect(code).toBe(1);
      const res = parseAgentOutput(stdout);
      expect(res.status).toBe('error');
      expect(res.code).toBe('TARGET_NOT_EMPTY');
      // Nothing was scaffolded over the existing contents.
      expect(readFileSync(join(dest, 'keep.txt'), 'utf8')).toBe('mine\n');
    });
  });
});
