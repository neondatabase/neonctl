import { describe, expect, it } from 'vitest';

import { resolveBranchRef } from './enrichers';
import type { BranchScopeProps } from '../types';

const BRANCHES = [
  { id: 'br-main-branch-000001', name: 'main', default: true },
  { id: 'br-feature-branch-000002', name: 'feature', default: false },
];

/** Minimal Api client stand-in: only `listProjectBranches` is exercised. */
const apiClient = {
  listProjectBranches: () => Promise.resolve({ data: { branches: BRANCHES } }),
} as never;

const props = (
  branch: Partial<{ branch: string; id: string }>,
): BranchScopeProps =>
  ({
    apiClient,
    apiKey: '',
    apiHost: '',
    output: 'table',
    contextFile: '',
    projectId: 'test',
    ...branch,
  }) as BranchScopeProps;

describe('resolveBranchRef', () => {
  it('resolves a branch by name to its id, carrying the name back', async () => {
    expect(await resolveBranchRef(props({ branch: 'feature' }))).toEqual({
      branchId: 'br-feature-branch-000002',
      branchName: 'feature',
      usedDefault: false,
    });
  });

  it('resolves a branch by id and looks up its friendly name', async () => {
    expect(
      await resolveBranchRef(props({ branch: 'br-feature-branch-000002' })),
    ).toEqual({
      branchId: 'br-feature-branch-000002',
      branchName: 'feature',
      usedDefault: false,
    });
  });

  it('reads the branch from the `id` positional when no `branch` is set', async () => {
    expect(await resolveBranchRef(props({ id: 'feature' }))).toEqual({
      branchId: 'br-feature-branch-000002',
      branchName: 'feature',
      usedDefault: false,
    });
  });

  it('trusts a br- id the listing does not return (no friendlier name)', async () => {
    expect(
      await resolveBranchRef(props({ branch: 'br-unknown-branch-999999' })),
    ).toEqual({
      branchId: 'br-unknown-branch-999999',
      branchName: 'br-unknown-branch-999999',
      usedDefault: false,
    });
  });

  it('falls back to the project default branch when none is specified', async () => {
    expect(await resolveBranchRef(props({}))).toEqual({
      branchId: 'br-main-branch-000001',
      branchName: 'main',
      usedDefault: true,
    });
  });

  it('throws a helpful error when a branch name does not resolve', async () => {
    await expect(resolveBranchRef(props({ branch: 'nope' }))).rejects.toThrow(
      /Branch nope not found.*Available branches: main, feature/s,
    );
  });
});
