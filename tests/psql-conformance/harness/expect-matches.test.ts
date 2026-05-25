import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetCache,
  expectMatches,
  filterByPgMajor,
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

describe('KNOWN_FAILURES.yml: pg-major filtering', () => {
  it('parses an entry with a string pg field', () => {
    const p = writeYaml(
      'pg-string.yml',
      `- test: regress/psql
  scope: full-file
  reason: "PG 18 added df+ columns"
  pg: '18'
`,
    );
    const entries = loadKnownFailures(p);
    expect(entries).toHaveLength(1);
    expect(entries[0].pg).toBe('18');
  });

  it('parses an entry with a numeric pg field (coerced to string)', () => {
    // YAML unquoted `14` parses to a number; ensure we coerce.
    const p = writeYaml(
      'pg-num.yml',
      `- test: regress/psql
  scope: full-file
  reason: "PG 14 quirk"
  pg: 14
`,
    );
    const entries = loadKnownFailures(p);
    expect(entries[0].pg).toBe('14');
  });

  it('rejects a non-string, non-number pg field', () => {
    const p = writeYaml(
      'pg-bad.yml',
      `- test: regress/psql
  scope: full-file
  reason: "oops"
  pg: [14, 15]
`,
    );
    expect(() => loadKnownFailures(p)).toThrowError(/invalid 'pg'/);
  });

  it('omits pg field on entries that do not set it', () => {
    const p = writeYaml(
      'pg-absent.yml',
      `- test: regress/psql
  scope: full-file
  reason: "applies to every PG"
`,
    );
    const entries = loadKnownFailures(p);
    expect(entries[0].pg).toBeUndefined();
  });
});

describe('filterByPgMajor', () => {
  const entries: KnownFailureEntry[] = [
    {
      test: 'regress/psql',
      scope: 'full-file',
      reason: 'applies to every PG',
    },
    {
      test: 'regress/psql_crosstab',
      scope: 'full-file',
      reason: 'PG 14 quirk',
      pg: '14',
    },
    {
      test: 'regress/psql_pipeline',
      scope: 'full-file',
      reason: 'PG 18 quirk',
      pg: '18',
    },
  ];

  it('keeps every entry when serverPgMajor is undefined', () => {
    expect(filterByPgMajor(entries, undefined)).toHaveLength(3);
  });

  it('keeps version-agnostic entries plus matching-version entries', () => {
    const filtered = filterByPgMajor(entries, '14');
    expect(filtered.map((e) => e.test)).toEqual([
      'regress/psql',
      'regress/psql_crosstab',
    ]);
  });

  it('drops non-matching-version entries', () => {
    const filtered = filterByPgMajor(entries, '15');
    expect(filtered.map((e) => e.test)).toEqual(['regress/psql']);
  });

  it('returns version-agnostic entries when no per-version entry matches', () => {
    const filtered = filterByPgMajor(entries, '17');
    expect(filtered.map((e) => e.test)).toEqual(['regress/psql']);
  });
});

describe('expectMatches: pg-major filter integration', () => {
  it('entry without pg field applies regardless of server version', () => {
    const p = writeYaml(
      'pg-int-1.yml',
      `- test: regress/psql
  scope: full-file
  reason: "always applicable"
`,
    );
    // Run as if on PG 18:
    const out = expectMatches(
      {
        testName: 'regress/psql',
        actualOutcome: 'fail',
        failureMessage: 'diff',
      },
      p,
      '18',
    );
    expect(out.kind).toBe('expected-failure');
    // ... and as if on PG 14:
    _resetCache();
    const out2 = expectMatches(
      {
        testName: 'regress/psql',
        actualOutcome: 'fail',
        failureMessage: 'diff',
      },
      p,
      '14',
    );
    expect(out2.kind).toBe('expected-failure');
  });

  it("entry with pg: '14' is skipped when server is 18 (unexpected failure)", () => {
    const p = writeYaml(
      'pg-int-2.yml',
      `- test: regress/psql
  scope: full-file
  reason: "PG 14 quirk"
  pg: '14'
`,
    );
    expect(() =>
      expectMatches(
        {
          testName: 'regress/psql',
          actualOutcome: 'fail',
          failureMessage: 'diff',
        },
        p,
        '18',
      ),
    ).toThrowError(/regress\/psql failed: diff/);
  });

  it("entry with pg: '14' applies when server is 14", () => {
    const p = writeYaml(
      'pg-int-3.yml',
      `- test: regress/psql
  scope: full-file
  reason: "PG 14 quirk"
  pg: '14'
`,
    );
    const out = expectMatches(
      {
        testName: 'regress/psql',
        actualOutcome: 'fail',
        failureMessage: 'diff',
      },
      p,
      '14',
    );
    expect(out.kind).toBe('expected-failure');
    if (out.kind === 'expected-failure') {
      expect(out.entry.pg).toBe('14');
      expect(out.entry.reason).toBe('PG 14 quirk');
    }
  });

  it('multiple entries for the same test but different pg fields: each evaluated separately', () => {
    const p = writeYaml(
      'pg-int-4.yml',
      `- test: regress/psql
  scope: full-file
  reason: "PG 14 quirk"
  pg: '14'
- test: regress/psql
  scope: full-file
  reason: "PG 18 quirk"
  pg: '18'
`,
    );
    // PG 14 -> matches PG-14 entry
    const out14 = expectMatches(
      {
        testName: 'regress/psql',
        actualOutcome: 'fail',
        failureMessage: 'diff',
      },
      p,
      '14',
    );
    expect(out14.kind).toBe('expected-failure');
    if (out14.kind === 'expected-failure') {
      expect(out14.entry.reason).toBe('PG 14 quirk');
    }
    // PG 18 -> matches PG-18 entry
    _resetCache();
    const out18 = expectMatches(
      {
        testName: 'regress/psql',
        actualOutcome: 'fail',
        failureMessage: 'diff',
      },
      p,
      '18',
    );
    expect(out18.kind).toBe('expected-failure');
    if (out18.kind === 'expected-failure') {
      expect(out18.entry.reason).toBe('PG 18 quirk');
    }
    // PG 15 -> no entry matches; unexpected failure.
    _resetCache();
    expect(() =>
      expectMatches(
        {
          testName: 'regress/psql',
          actualOutcome: 'fail',
          failureMessage: 'diff',
        },
        p,
        '15',
      ),
    ).toThrowError(/regress\/psql failed: diff/);
  });

  it('a PG-only entry on a passing test does NOT count as a regression off-version', () => {
    // pg: '14' entry, but running on PG 18 with actual=pass. Filter
    // strips the entry first, so quadrant 1 (pass + not-in-list) wins.
    const p = writeYaml(
      'pg-int-5.yml',
      `- test: regress/psql
  scope: full-file
  reason: "PG 14 quirk"
  pg: '14'
`,
    );
    const out = expectMatches(
      { testName: 'regress/psql', actualOutcome: 'pass' },
      p,
      '18',
    );
    expect(out.kind).toBe('pass');
  });
});
