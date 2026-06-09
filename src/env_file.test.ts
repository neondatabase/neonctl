import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadEnvFileIntoProcess,
  mergeEnvContent,
  readEnvFile,
  resolveEnvFilePath,
} from './env_file.js';

describe('mergeEnvContent', () => {
  it('writes keys into an empty file with a trailing newline', () => {
    const { content, written } = mergeEnvContent('', {
      DATABASE_URL: 'postgres://x',
    });
    expect(content).toBe('DATABASE_URL=postgres://x\n');
    expect(written).toEqual(['DATABASE_URL']);
  });

  it('updates an existing key in place, preserving position and other lines', () => {
    const original = [
      '# my env',
      'FOO=bar',
      'DATABASE_URL=postgres://old',
      'BAZ=qux',
      '',
    ].join('\n');
    const { content } = mergeEnvContent(original, {
      DATABASE_URL: 'postgres://new',
    });
    expect(content).toBe(
      ['# my env', 'FOO=bar', 'DATABASE_URL=postgres://new', 'BAZ=qux'].join(
        '\n',
      ) + '\n',
    );
  });

  it('appends new keys after existing content', () => {
    const original = 'FOO=bar\n';
    const { content, written } = mergeEnvContent(original, {
      DATABASE_URL: 'postgres://x',
      NEON_AUTH_BASE_URL: 'https://auth',
    });
    expect(content).toBe(
      [
        'FOO=bar',
        'DATABASE_URL=postgres://x',
        'NEON_AUTH_BASE_URL=https://auth',
      ].join('\n') + '\n',
    );
    expect(written).toEqual(['DATABASE_URL', 'NEON_AUTH_BASE_URL']);
  });

  it('preserves comments and blank lines, and a leading `export`', () => {
    const original = [
      '# header',
      '',
      'export DATABASE_URL=old',
      '# trailing comment',
    ].join('\n');
    const { content } = mergeEnvContent(original, { DATABASE_URL: 'new' });
    // The `export ` form is matched for the key, replaced with the canonical KEY=value.
    expect(content).toContain('# header');
    expect(content).toContain('# trailing comment');
    expect(content).toContain('DATABASE_URL=new');
  });

  it('quotes values that contain special characters', () => {
    const { content } = mergeEnvContent('', {
      DATABASE_URL: 'postgres://u:p w@h/db?x=1',
    });
    expect(content).toBe('DATABASE_URL="postgres://u:p w@h/db?x=1"\n');
  });

  it('is a no-op for empty updates', () => {
    const original = 'FOO=bar\n';
    const { content, written } = mergeEnvContent(original, {});
    expect(content).toBe(original);
    expect(written).toEqual([]);
  });

  it('does not accumulate trailing blank lines across merges', () => {
    const first = mergeEnvContent('', { A: '1' }).content;
    const second = mergeEnvContent(first, { B: '2' }).content;
    expect(second).toBe('A=1\nB=2\n');
  });
});

describe('resolveEnvFilePath', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'neonctl-envfile-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('uses an explicit --file when given', () => {
    expect(resolveEnvFilePath(cwd, '.env.preview')).toBe(
      join(cwd, '.env.preview'),
    );
  });

  it('defaults to .env.local when no .env exists', () => {
    expect(resolveEnvFilePath(cwd)).toBe(join(cwd, '.env.local'));
  });

  it('uses an existing .env when present (vercel-style)', () => {
    writeFileSync(join(cwd, '.env'), 'EXISTING=1\n');
    expect(resolveEnvFilePath(cwd)).toBe(join(cwd, '.env'));
  });
});

describe('readEnvFile', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'neonctl-readenv-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('parses assignments, ignoring comments / blanks and unquoting values', () => {
    const path = join(cwd, '.env');
    writeFileSync(
      path,
      [
        '# a comment',
        '',
        'PLAIN=value',
        'export EXPORTED=exp',
        'QUOTED="has space"',
        "SINGLE='single'",
        'not an assignment',
      ].join('\n'),
    );
    expect(readEnvFile(path)).toEqual({
      PLAIN: 'value',
      EXPORTED: 'exp',
      QUOTED: 'has space',
      SINGLE: 'single',
    });
  });

  it('throws when the file does not exist', () => {
    expect(() => readEnvFile(join(cwd, 'missing.env'))).toThrow(
      /Env file not found/,
    );
  });
});

describe('loadEnvFileIntoProcess', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'neonctl-loadenv-'));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    delete process.env.NEONCTL_TEST_LOADENV_NEW;
    delete process.env.NEONCTL_TEST_LOADENV_EXISTING;
  });

  it('sets unset vars but never overrides existing process.env entries', () => {
    process.env.NEONCTL_TEST_LOADENV_EXISTING = 'from-process';
    const path = join(cwd, '.env');
    writeFileSync(
      path,
      'NEONCTL_TEST_LOADENV_NEW=from-file\nNEONCTL_TEST_LOADENV_EXISTING=from-file\n',
    );

    const applied = loadEnvFileIntoProcess(path);

    expect(process.env.NEONCTL_TEST_LOADENV_NEW).toBe('from-file');
    expect(process.env.NEONCTL_TEST_LOADENV_EXISTING).toBe('from-process');
    expect(applied).toEqual(['NEONCTL_TEST_LOADENV_NEW']);
  });
});
