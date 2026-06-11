import { describe, expect, it } from 'vitest';

import {
  GitTreeNode,
  parseManifest,
  selectSubtreeEntries,
} from './bootstrap.js';

const tree: GitTreeNode[] = [
  { path: 'with-hono', mode: '040000', type: 'tree' },
  { path: 'with-hono/package.json', mode: '100644', type: 'blob' },
  { path: 'with-hono/src', mode: '040000', type: 'tree' },
  { path: 'with-hono/src/index.ts', mode: '100644', type: 'blob' },
  { path: 'with-hono/scripts/run.sh', mode: '100755', type: 'blob' },
  { path: 'with-hono/.claude/skills/neon', mode: '120000', type: 'blob' },
  // A different example in the same repo must never leak into the copy.
  { path: 'with-remix/package.json', mode: '100644', type: 'blob' },
  // A submodule (commit) is not a copyable blob.
  { path: 'with-hono/vendor', mode: '160000', type: 'commit' },
];

describe('selectSubtreeEntries', () => {
  it('keeps only blobs under the subdir and strips the prefix', () => {
    const entries = selectSubtreeEntries(tree, 'with-hono');
    expect(entries.map((e) => e.path).sort()).toEqual([
      '.claude/skills/neon',
      'package.json',
      'scripts/run.sh',
      'src/index.ts',
    ]);
  });

  it('classifies symlinks, executables, and regular files by git mode', () => {
    const byPath = Object.fromEntries(
      selectSubtreeEntries(tree, 'with-hono').map((e) => [e.path, e]),
    );

    expect(byPath['.claude/skills/neon']).toMatchObject({ kind: 'symlink' });
    expect(byPath['scripts/run.sh']).toMatchObject({
      kind: 'file',
      executable: true,
    });
    expect(byPath['package.json']).toMatchObject({
      kind: 'file',
      executable: false,
    });
  });

  it('preserves the full repo path for fetching raw content', () => {
    const entries = selectSubtreeEntries(tree, 'with-hono');
    const pkg = entries.find((e) => e.path === 'package.json');
    expect(pkg?.repoPath).toBe('with-hono/package.json');
  });

  it('tolerates a trailing slash on the subdir', () => {
    expect(selectSubtreeEntries(tree, 'with-hono/')).toHaveLength(4);
  });

  it('returns nothing for a subdir that does not exist', () => {
    expect(selectSubtreeEntries(tree, 'nope')).toEqual([]);
  });
});

describe('parseManifest', () => {
  it('parses a valid manifest', () => {
    const yaml = `templates:
  - id: hono
    title: Hono API
    description: A Hono template.
    source:
      owner: neondatabase
      repo: examples
      ref: main
      subdir: with-hono
`;
    const templates = parseManifest(yaml);
    expect(templates).toHaveLength(1);
    expect(templates[0]).toEqual({
      id: 'hono',
      title: 'Hono API',
      description: 'A Hono template.',
      source: {
        owner: 'neondatabase',
        repo: 'examples',
        ref: 'main',
        subdir: 'with-hono',
      },
    });
  });

  it('skips malformed entries and keeps valid ones', () => {
    const yaml = `templates:
  - id: good
    title: Good
    description: A good template.
    source:
      owner: org
      repo: repo
      ref: main
      subdir: good
  - id: bad-no-source
    title: Bad
    description: Missing source field.
  - not-even-an-object
`;
    const templates = parseManifest(yaml);
    expect(templates).toHaveLength(1);
    expect(templates[0].id).toBe('good');
  });

  it('returns an empty array when all entries are malformed', () => {
    const yaml = `templates:
  - id: 123
    title: numeric id
`;
    expect(parseManifest(yaml)).toEqual([]);
  });

  it('throws when the top-level structure is invalid', () => {
    expect(() => parseManifest('not-yaml: []')).toThrow(
      'missing "templates" array',
    );
    expect(() => parseManifest('templates: not-an-array')).toThrow(
      'missing "templates" array',
    );
  });

  it('handles an empty templates array', () => {
    expect(parseManifest('templates: []')).toEqual([]);
  });
});
