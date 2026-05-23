import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { currentContextFile } from './context.js';

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
