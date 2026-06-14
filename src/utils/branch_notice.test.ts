import { afterEach, describe, expect, it, vi } from 'vitest';
import strip from 'strip-ansi';

import { announceTargetBranch } from './branch_notice';
import type { ResolvedBranchRef } from './enrichers';

const ref: ResolvedBranchRef = {
  branchId: 'br-snowy-frost-12345',
  branchName: 'main',
  usedDefault: false,
};

/** Capture everything written to stderr (where the notice goes), ANSI stripped. */
const captureStderr = (): { read: () => string; restore: () => void } => {
  let buffer = '';
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      buffer += chunk.toString();
      return true;
    });
  return {
    read: () => strip(buffer),
    restore: () => {
      spy.mockRestore();
    },
  };
};

describe('announceTargetBranch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a one-line notice with the verb, branch name and id (table output)', () => {
    const { read, restore } = captureStderr();
    announceTargetBranch({ output: 'table' }, ref, 'Planning against branch');
    restore();

    const out = read();
    expect(out).toContain('Planning against branch');
    expect(out).toContain('main');
    expect(out).toContain('(br-snowy-frost-12345)');
    // The notice is a single stderr line.
    expect(out.trim().split('\n')).toHaveLength(1);
  });

  it('notes when the project default branch was used as a fallback', () => {
    const { read, restore } = captureStderr();
    announceTargetBranch(
      { output: 'table' },
      { ...ref, usedDefault: true },
      'Pulling env from branch',
    );
    restore();

    expect(read()).toContain('project default');
  });

  it('stays silent for machine-readable output so piped stdout/stderr is clean', () => {
    for (const output of ['json', 'yaml'] as const) {
      const { read, restore } = captureStderr();
      announceTargetBranch({ output }, ref, 'Inspecting branch');
      restore();
      expect(read()).toBe('');
    }
  });
});
