import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetCache,
  expectMatches,
  findKnownFailure,
  loadKnownFailures,
  type KnownFailureEntry,
} from './expect-matches.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'psqlconf-'));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeYaml(name: string, body: string): string {
  const p = join(tmpRoot, name);
  writeFileSync(p, body, 'utf8');
  return p;
}

beforeEach(() => {
  _resetCache();
});

describe('loadKnownFailures', () => {
  it('parses an empty array', () => {
    const p = writeYaml('empty.yml', '[]\n');
    expect(loadKnownFailures(p)).toEqual([]);
  });

  it('parses null / no content as empty', () => {
    const p = writeYaml('null.yml', '# only a comment\n');
    expect(loadKnownFailures(p)).toEqual([]);
  });

  it('parses a full-file entry', () => {
    const p = writeYaml(
      'full.yml',
      `- test: regress/psql
  scope: full-file
  reason: "WP-14 not landed"
  owner: '@team-cli'
  added: 2026-05-25
`,
    );
    const entries = loadKnownFailures(p);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      test: 'regress/psql',
      scope: 'full-file',
      reason: 'WP-14 not landed',
      owner: '@team-cli',
      added: '2026-05-25',
    });
  });

  it('parses a subtest entry', () => {
    const p = writeYaml(
      'sub.yml',
      `- test: tap/001_basic
  scope: subtest
  subtest: '\\copy command with bad column'
  reason: "WP-16"
`,
    );
    const entries = loadKnownFailures(p);
    expect(entries[0]).toMatchObject({
      test: 'tap/001_basic',
      scope: 'subtest',
      subtest: '\\copy command with bad column',
    });
  });

  it('rejects non-array top level', () => {
    const p = writeYaml('bad.yml', 'foo: bar\n');
    expect(() => loadKnownFailures(p)).toThrowError(/must be a YAML list/);
  });

  it('rejects subtest entry with no subtest field', () => {
    const p = writeYaml(
      'bad2.yml',
      `- test: tap/001_basic
  scope: subtest
  reason: oops
`,
    );
    expect(() => loadKnownFailures(p)).toThrowError(/no 'subtest' name/);
  });

  it('rejects invalid scope', () => {
    const p = writeYaml(
      'bad3.yml',
      `- test: tap/001_basic
  scope: bogus
  reason: oops
`,
    );
    expect(() => loadKnownFailures(p)).toThrowError(/invalid 'scope'/);
  });
});

describe('findKnownFailure', () => {
  const entries: KnownFailureEntry[] = [
    {
      test: 'regress/psql',
      scope: 'full-file',
      reason: 'a',
    },
    {
      test: 'tap/001_basic',
      scope: 'subtest',
      subtest: 'connect ok',
      reason: 'b',
    },
  ];

  it('matches full-file regardless of subtest name', () => {
    expect(
      findKnownFailure(
        { testName: 'regress/psql', actualOutcome: 'fail' },
        entries,
      ),
    ).toBeDefined();
    expect(
      findKnownFailure(
        {
          testName: 'regress/psql',
          subtestName: 'anything',
          actualOutcome: 'fail',
        },
        entries,
      ),
    ).toBeDefined();
  });

  it('matches subtest by exact subtest name', () => {
    expect(
      findKnownFailure(
        {
          testName: 'tap/001_basic',
          subtestName: 'connect ok',
          actualOutcome: 'fail',
        },
        entries,
      ),
    ).toBeDefined();
  });

  it('does not match a different subtest', () => {
    expect(
      findKnownFailure(
        {
          testName: 'tap/001_basic',
          subtestName: 'something else',
          actualOutcome: 'fail',
        },
        entries,
      ),
    ).toBeUndefined();
  });

  it('returns undefined for unknown test', () => {
    expect(
      findKnownFailure(
        { testName: 'regress/foo', actualOutcome: 'fail' },
        entries,
      ),
    ).toBeUndefined();
  });
});

describe('expectMatches: 4-quadrant truth table', () => {
  it('quadrant 1: actual=pass, NOT in list -> pass', () => {
    const p = writeYaml('q1.yml', '[]\n');
    expect(
      expectMatches({ testName: 'regress/psql', actualOutcome: 'pass' }, p),
    ).toEqual({ kind: 'pass' });
  });

  it('quadrant 2: actual=pass, IS in list -> regression error', () => {
    const p = writeYaml(
      'q2.yml',
      `- test: regress/psql
  scope: full-file
  reason: "stale entry"
`,
    );
    expect(() =>
      expectMatches({ testName: 'regress/psql', actualOutcome: 'pass' }, p),
    ).toThrowError(/REGRESSION.*now passes.*Remove that entry/s);
  });

  it('quadrant 3: actual=fail, IS in list -> expected-failure', () => {
    const p = writeYaml(
      'q3.yml',
      `- test: regress/psql
  scope: full-file
  reason: "WP-14 outstanding"
`,
    );
    const out = expectMatches(
      {
        testName: 'regress/psql',
        actualOutcome: 'fail',
        failureMessage: 'diff mismatch',
      },
      p,
    );
    expect(out.kind).toBe('expected-failure');
    if (out.kind === 'expected-failure') {
      expect(out.entry.reason).toBe('WP-14 outstanding');
    }
  });

  it('quadrant 4: actual=fail, NOT in list -> fail', () => {
    const p = writeYaml('q4.yml', '[]\n');
    expect(() =>
      expectMatches(
        {
          testName: 'regress/psql',
          actualOutcome: 'fail',
          failureMessage: 'diff mismatch',
        },
        p,
      ),
    ).toThrowError(/regress\/psql failed: diff mismatch/);
  });

  it('quadrant 3 — subtest variant matches by subtest name', () => {
    const p = writeYaml(
      'q3sub.yml',
      `- test: tap/001_basic
  scope: subtest
  subtest: copy bad column
  reason: "WP-16 outstanding"
`,
    );
    const out = expectMatches(
      {
        testName: 'tap/001_basic',
        subtestName: 'copy bad column',
        actualOutcome: 'fail',
        failureMessage: 'oops',
      },
      p,
    );
    expect(out.kind).toBe('expected-failure');
  });

  it('quadrant 4 — subtest not in list still fails even if testName has a different subtest entry', () => {
    const p = writeYaml(
      'q4sub.yml',
      `- test: tap/001_basic
  scope: subtest
  subtest: a different subtest
  reason: "WP-16 outstanding"
`,
    );
    expect(() =>
      expectMatches(
        {
          testName: 'tap/001_basic',
          subtestName: 'connect ok',
          actualOutcome: 'fail',
          failureMessage: 'diff',
        },
        p,
      ),
    ).toThrowError(/tap\/001_basic :: connect ok failed/);
  });
});
