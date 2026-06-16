import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  currentGitBranch,
  installPostCheckoutHook,
  isGitRepo,
  isManagedHook,
  postCheckoutHookPath,
  readGitContext,
  removePostCheckoutHook,
} from './git.js';

const run = (args: string[], cwd: string) =>
  execFileSync('git', args, { cwd, stdio: 'ignore' });

const initRepo = (dir: string) => {
  run(['init', '-b', 'main'], dir);
  run(['config', 'user.email', 'test@example.com'], dir);
  run(['config', 'user.name', 'Test'], dir);
  // Pin a repo-local hooks dir so the suite is hermetic even when the machine has a global
  // `core.hooksPath` (e.g. a managed githooks directory) that would otherwise be targeted.
  run(['config', 'core.hooksPath', '.git/hooks'], dir);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  run(['add', '.'], dir);
  run(['commit', '-m', 'init'], dir);
};

describe('git facts', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'neonctl-git-'));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test('reports available:false outside a git repo', () => {
    const ctx = readGitContext(repo);
    expect(ctx.available).toBe(false);
    expect(ctx.branch).toBeUndefined();
    expect(ctx.triggeredByGitHook).toBe(false);
  });

  test('reads the current branch, sha, and clean/dirty state', () => {
    initRepo(repo);
    expect(isGitRepo(repo)).toBe(true);
    expect(currentGitBranch(repo)).toBe('main');

    const clean = readGitContext(repo);
    expect(clean.available).toBe(true);
    expect(clean.branch).toBe('main');
    expect(clean.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.shortSha).toBeDefined();
    expect(clean.isDirty).toBe(false);
    expect(clean.isDetached).toBe(false);

    writeFileSync(join(repo, 'new.txt'), 'x');
    expect(readGitContext(repo).isDirty).toBe(true);
  });

  test('threads the triggeredByGitHook flag through', () => {
    initRepo(repo);
    expect(
      readGitContext(repo, { triggeredByGitHook: true }).triggeredByGitHook,
    ).toBe(true);
  });

  test('detects detached HEAD as isDetached with no branch', () => {
    initRepo(repo);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim();
    run(['checkout', sha], repo);
    const ctx = readGitContext(repo);
    expect(ctx.isDetached).toBe(true);
    expect(ctx.branch).toBeUndefined();
  });
});

describe('post-checkout hook management', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'neonctl-hook-'));
    initRepo(repo);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test('installs a managed hook, then refreshes it (idempotent)', () => {
    const first = installPostCheckoutHook(repo);
    expect(first.status).toBe('installed');
    const hookPath = postCheckoutHookPath(repo);
    expect(existsSync(hookPath)).toBe(true);
    expect(isManagedHook(hookPath)).toBe(true);
    expect(readFileSync(hookPath, 'utf-8')).toContain('neonctl git sync');

    const second = installPostCheckoutHook(repo);
    expect(second.status).toBe('updated');
  });

  test('refuses to clobber a foreign hook', () => {
    const hookPath = postCheckoutHookPath(repo);
    writeFileSync(hookPath, '#!/bin/sh\necho not ours\n');
    const result = installPostCheckoutHook(repo);
    expect(result.status).toBe('conflict');
    // Foreign content untouched.
    expect(readFileSync(hookPath, 'utf-8')).toContain('not ours');
  });

  test('removes a managed hook but leaves a foreign one', () => {
    installPostCheckoutHook(repo);
    expect(removePostCheckoutHook(repo)).toBe('removed');
    expect(removePostCheckoutHook(repo)).toBe('absent');

    const hookPath = postCheckoutHookPath(repo);
    writeFileSync(hookPath, '#!/bin/sh\necho not ours\n');
    expect(removePostCheckoutHook(repo)).toBe('foreign');
    expect(existsSync(hookPath)).toBe(true);
  });
});
