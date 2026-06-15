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
import { gzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

// A fixture file in the template repo: its POSIX `mode`/`type` decide whether it
// lands as a regular file, an executable, or a symlink.
type FixtureFile =
  | { type: 'file'; mode: number; content: string }
  | { type: 'symlink'; target: string };

// Keyed by repo-relative path. The `with-hono` subdir mirrors what the real
// `hono` template uses; `with-remix/...` must be filtered out as a sibling.
const FIXTURE: Record<string, FixtureFile> = {
  'with-hono/package.json': {
    type: 'file',
    mode: 0o644,
    content: '{\n  "name": "with-hono"\n}\n',
  },
  'with-hono/src/index.ts': {
    type: 'file',
    mode: 0o644,
    content: 'export const app = "hono";\n',
  },
  'with-hono/scripts/run.sh': {
    type: 'file',
    mode: 0o755,
    content: '#!/bin/sh\necho hi\n',
  },
  'with-hono/.claude/skills/neon': {
    type: 'symlink',
    target: '../../package.json',
  },
  'with-remix/package.json': {
    type: 'file',
    mode: 0o644,
    content: '{ "name": "with-remix" }\n',
  },
};

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

// Build a ustar header block, matching what GitHub's codeload tarballs emit.
const tarHeader = (
  name: string,
  size: number,
  mode: number,
  typeflag: string,
  linkname = '',
): Buffer => {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 'utf8');
  header.write(`${(mode & 0o7777).toString(8).padStart(7, '0')}\0`, 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(typeflag, 156, 1);
  header.write(linkname, 157, 'utf8');
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += header[i];
  }
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
};

const padTo512 = (buf: Buffer): Buffer => {
  const rem = buf.length % 512;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(512 - rem)]);
};

// Pack the fixture into a gzipped tar shaped like codeload: a single
// "examples-main/" top-level dir wrapping every repo-relative path.
const makeTarball = (): Buffer => {
  const blocks: Buffer[] = [tarHeader('pax_global_header', 0, 0o644, 'g')];
  for (const [path, file] of Object.entries(FIXTURE)) {
    const name = `examples-main/${path}`;
    if (file.type === 'symlink') {
      blocks.push(tarHeader(name, 0, 0o777, '2', file.target));
    } else {
      const content = Buffer.from(file.content);
      blocks.push(tarHeader(name, content.length, file.mode, '0'));
      blocks.push(padTo512(content));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.from(gzipSync(new Uint8Array(Buffer.concat(blocks))));
};

// A real local HTTP server standing in for the codeload tarball host + the
// manifest host, so the whole download/extract path runs end to end with no
// mocking of our own code.
const startGithubFixtureServer = (): Promise<Server> => {
  const app = express();

  app.get('/manifest/bootstrap.yaml', (_req, res) => {
    res.type('text/yaml').send(MANIFEST_YAML);
  });

  // Mirrors https://codeload.github.com/:owner/:repo/tar.gz/:ref
  app.get('/:owner/:repo/tar.gz/:ref', (_req, res) => {
    res.type('application/gzip').send(makeTarball());
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
          NEON_BOOTSTRAP_GITHUB_CODELOAD: base,
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
