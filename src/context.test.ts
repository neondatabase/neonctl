/**
 * Tests for the `.neon` middleware. The carve-out for `launch` is
 * load-bearing: `context.branchId` is a Neon API id (e.g. `br_abc123`),
 * NOT a git branch name. Writing it into `args.branch` for the launch
 * command would silently corrupt every Neon-branch name + Vercel-env-
 * scoping derived from `ctx.gitBranch`. Pin the carve-out so a refactor
 * can't drop it.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { enrichFromContext } from './context.js';

function withContextFile(contents: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'neon-ctx-test-'));
  const path = join(dir, '.neon');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

describe('enrichFromContext carve-out for `launch`', () => {
  it('launch command does NOT inherit context.branchId into args.branch', () => {
    const contextFile = withContextFile({
      projectId: 'prj_1',
      branchId: 'br_abc123',
    });
    const args = {
      _: ['launch'],
      contextFile,
      // simulate yargs's resolved projectId after middleware ran first
      projectId: 'prj_1',
    } as unknown as Parameters<typeof enrichFromContext>[0];
    enrichFromContext(args);
    expect((args as unknown as { branch?: unknown }).branch).toBeUndefined();
  });

  it('non-launch commands STILL inherit context.branchId (existing behavior preserved)', () => {
    const contextFile = withContextFile({
      projectId: 'prj_1',
      branchId: 'br_abc123',
    });
    const args = {
      _: ['branches', 'list'],
      contextFile,
      projectId: 'prj_1',
    } as unknown as Parameters<typeof enrichFromContext>[0];
    enrichFromContext(args);
    expect((args as unknown as { branch?: unknown }).branch).toBe('br_abc123');
  });

  it('explicit args.branch is never overwritten regardless of command', () => {
    const contextFile = withContextFile({
      projectId: 'prj_1',
      branchId: 'br_from_context',
    });
    const args = {
      _: ['branches', 'list'],
      contextFile,
      projectId: 'prj_1',
      branch: 'br_explicit',
    } as unknown as Parameters<typeof enrichFromContext>[0];
    enrichFromContext(args);
    expect((args as unknown as { branch?: unknown }).branch).toBe(
      'br_explicit',
    );
  });
});
