import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  applyContext,
  currentContextFile,
  ensureGitignored,
} from './context.js';

describe('currentContextFile', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'neonctl-ctx-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test('defaults to <cwd>/.neon when no .neon exists anywhere upward', () => {
    const sub = join(workspace, 'sub');
    mkdirSync(sub);
    expect(currentContextFile(sub)).toBe(join(sub, '.neon'));
  });

  test('walks up to an existing .neon in a parent directory', () => {
    writeFileSync(
      join(workspace, '.neon'),
      JSON.stringify({ projectId: 'parent-project' }),
    );
    const sub = join(workspace, 'nested', 'deeper');
    mkdirSync(sub, { recursive: true });
    expect(currentContextFile(sub)).toBe(join(workspace, '.neon'));
  });

  test('does NOT walk up for unrelated project markers (package.json, .git)', () => {
    // Regression: previously `currentContextFile` treated `package.json` and
    // `.git` as project markers and walked up to them, which made
    // `neonctl link` from a fresh sub-directory inside an existing repo land
    // its `.neon` at the parent repo's root instead of the cwd.
    writeFileSync(join(workspace, 'package.json'), '{}');
    mkdirSync(join(workspace, '.git'));
    const sub = join(workspace, 'fresh-sub');
    mkdirSync(sub);
    expect(currentContextFile(sub)).toBe(join(sub, '.neon'));
  });
});

describe('ensureGitignored', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'neonctl-gi-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test('creates a .gitignore listing .neon when none exists', () => {
    const contextFile = join(workspace, '.neon');
    ensureGitignored(contextFile);
    const gitignore = readFileSync(join(workspace, '.gitignore'), 'utf-8');
    expect(gitignore).toBe('.neon\n');
  });

  test('appends .neon to an existing .gitignore that does not have it', () => {
    const gi = join(workspace, '.gitignore');
    writeFileSync(gi, 'node_modules\ndist\n');
    ensureGitignored(join(workspace, '.neon'));
    expect(readFileSync(gi, 'utf-8')).toBe('node_modules\ndist\n.neon\n');
  });

  test('does not duplicate .neon when already present', () => {
    const gi = join(workspace, '.gitignore');
    writeFileSync(gi, 'node_modules\n.neon\ndist\n');
    ensureGitignored(join(workspace, '.neon'));
    expect(readFileSync(gi, 'utf-8')).toBe('node_modules\n.neon\ndist\n');
  });

  test('tolerates a .gitignore that has no trailing newline', () => {
    const gi = join(workspace, '.gitignore');
    writeFileSync(gi, 'node_modules');
    ensureGitignored(join(workspace, '.neon'));
    expect(readFileSync(gi, 'utf-8')).toBe('node_modules\n.neon\n');
  });

  test('treats surrounding whitespace as part of the line', () => {
    const gi = join(workspace, '.gitignore');
    // Trailing spaces around the entry should still count as a match.
    writeFileSync(gi, '  .neon  \n');
    ensureGitignored(join(workspace, '.neon'));
    expect(readFileSync(gi, 'utf-8')).toBe('  .neon  \n');
  });

  test('does NOT match partial entries like *.neon or foo/.neon', () => {
    const gi = join(workspace, '.gitignore');
    writeFileSync(gi, '*.neon\nfoo/.neon\n');
    ensureGitignored(join(workspace, '.neon'));
    expect(readFileSync(gi, 'utf-8')).toBe('*.neon\nfoo/.neon\n.neon\n');
  });
});

describe('applyContext', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'neonctl-apply-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test('scaffolds .gitignore only when the context file is created', () => {
    const file = join(workspace, '.neon');
    applyContext(file, {
      orgId: 'org-x',
      projectId: 'proj-y',
      branchId: 'br-z',
    });
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
      orgId: 'org-x',
      projectId: 'proj-y',
      branchId: 'br-z',
    });
    expect(readFileSync(join(workspace, '.gitignore'), 'utf-8')).toBe(
      '.neon\n',
    );
  });

  test('does NOT re-add .neon to .gitignore on updates to an existing file', () => {
    const file = join(workspace, '.neon');
    // First write creates the file and scaffolds .gitignore.
    applyContext(file, { projectId: 'proj-y', branchId: 'br-1' });
    // The user deliberately un-ignores .neon (e.g. to commit shared context).
    writeFileSync(join(workspace, '.gitignore'), 'node_modules\n');

    // A subsequent update must NOT re-add the entry.
    applyContext(file, { projectId: 'proj-y', branchId: 'br-2' });

    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
      projectId: 'proj-y',
      branchId: 'br-2',
    });
    expect(readFileSync(join(workspace, '.gitignore'), 'utf-8')).toBe(
      'node_modules\n',
    );
  });
});
