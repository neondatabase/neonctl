import { describe, expect, test } from 'vitest';

import { partitionBranchesToPrune } from './git.js';

describe('partitionBranchesToPrune', () => {
  const branches = [
    { id: 'br-main', name: 'main', default: true },
    { id: 'br-prod', name: 'production', protected: true },
    { id: 'br-x', name: 'preview/x' },
    { id: 'br-y', name: 'preview/y' },
    { id: 'br-live', name: 'preview/live' }, // mapped from a still-present git branch
  ];

  test('deletes only orphaned, non-default, non-protected branches', () => {
    const orphans = new Set(['main', 'production', 'preview/x', 'preview/y']);
    const { toDelete, skipped } = partitionBranchesToPrune(branches, orphans);

    expect(toDelete.map((b) => b.name).sort()).toEqual([
      'preview/x',
      'preview/y',
    ]);
    expect(skipped).toEqual([
      { name: 'main', reason: 'default branch' },
      { name: 'production', reason: 'protected' },
    ]);
  });

  test('never touches a branch that is not orphaned', () => {
    const { toDelete } = partitionBranchesToPrune(
      branches,
      new Set(['preview/x']),
    );
    expect(toDelete.map((b) => b.name)).toEqual(['preview/x']);
    // `preview/live` is not in the orphan set → kept.
    expect(toDelete.some((b) => b.name === 'preview/live')).toBe(false);
  });

  test('returns nothing to delete when there are no orphans', () => {
    const { toDelete, skipped } = partitionBranchesToPrune(branches, new Set());
    expect(toDelete).toEqual([]);
    expect(skipped).toEqual([]);
  });
});
