// KNOWN_FAILURES-aware assertion. Implements the 4-quadrant truth
// table from the WP-T plan:
//
//   actualOutcome  in KNOWN_FAILURES   result
//   ─────────────  ──────────────────  ──────────────────────────────
//   pass           no                  pass
//   pass           yes                 FAIL (regression — drop entry)
//   fail           yes                 pass (expected failure)
//   fail           no                  fail
//
// This is the keystone for parallel WP work: every TS psql package
// that ships removes entries here; the assertion mechanically fails
// if a stale entry remains.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export type KnownFailureScope = 'full-file' | 'subtest';

export type KnownFailureEntry = {
  test: string;
  scope: KnownFailureScope;
  subtest?: string;
  reason: string;
  owner?: string;
  ticket?: string;
  added?: string;
  /**
   * Optional PG major version (`'14'`..`'18'`). When set, the entry
   * only applies to runs against that PG major. When unset, the entry
   * applies to every PG major. The running version is read from
   * `$PGCONFORMANCE_PG_MAJOR` (set by the workflow matrix).
   */
  pg?: string;
};

export type ExpectInput = {
  /** e.g. 'regress/psql', 'tap/001_basic'. Matches `test` in the YAML. */
  testName: string;
  /** Required when matching a `scope: subtest` entry. */
  subtestName?: string;
  /** Result of running the test against PSQL_BINARY. */
  actualOutcome: 'pass' | 'fail';
  /** When `actualOutcome === 'fail'`, a short failure message. */
  failureMessage?: string;
};

export type ExpectOutcome =
  | { kind: 'pass'; note?: string }
  | { kind: 'expected-failure'; entry: KnownFailureEntry };

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_KNOWN_FAILURES = join(HERE, '..', 'KNOWN_FAILURES.yml');

let cachedPath: string | null = null;
let cachedEntries: KnownFailureEntry[] | null = null;

/**
 * Load and parse KNOWN_FAILURES.yml. Cached per-path to avoid repeat
 * disk reads inside a single vitest worker.
 *
 * Pass a custom path for unit tests; production callers can omit it.
 */
export function loadKnownFailures(
  path: string = DEFAULT_KNOWN_FAILURES,
): KnownFailureEntry[] {
  if (cachedPath === path && cachedEntries) {
    return cachedEntries;
  }
  const raw = readFileSync(path, 'utf8');
  const parsed: unknown = YAML.parse(raw);
  const entries = normalizeYamlEntries(parsed, path);
  cachedPath = path;
  cachedEntries = entries;
  return entries;
}

/** Reset the in-memory cache. Exposed for unit tests. */
export function _resetCache(): void {
  cachedPath = null;
  cachedEntries = null;
}

function normalizeYamlEntries(
  parsed: unknown,
  path: string,
): KnownFailureEntry[] {
  if (parsed === null || parsed === undefined) {
    return [];
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `KNOWN_FAILURES.yml (${path}) must be a YAML list at the top level`,
    );
  }
  return parsed.map((raw, i) => validateEntry(raw, i, path));
}

function validateEntry(
  raw: unknown,
  index: number,
  path: string,
): KnownFailureEntry {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(
      `KNOWN_FAILURES.yml (${path}) entry #${index} is not an object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const test = obj.test;
  const scope = obj.scope;
  const reason = obj.reason;
  if (typeof test !== 'string' || test.length === 0) {
    throw new Error(
      `KNOWN_FAILURES.yml (${path}) entry #${index} is missing 'test'`,
    );
  }
  if (scope !== 'full-file' && scope !== 'subtest') {
    throw new Error(
      `KNOWN_FAILURES.yml (${path}) entry #${index} has invalid 'scope' (got ${String(scope)})`,
    );
  }
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new Error(
      `KNOWN_FAILURES.yml (${path}) entry #${index} is missing 'reason'`,
    );
  }
  if (scope === 'subtest') {
    if (typeof obj.subtest !== 'string' || obj.subtest.length === 0) {
      throw new Error(
        `KNOWN_FAILURES.yml (${path}) entry #${index} (test=${test}) has scope=subtest but no 'subtest' name`,
      );
    }
  }
  // Coerce `pg` to a string — YAML readers often parse `14` as a
  // number, but we treat it canonically as a PG major string ('14').
  let pg: string | undefined;
  if (obj.pg !== undefined && obj.pg !== null) {
    if (typeof obj.pg === 'string') {
      pg = obj.pg;
    } else if (typeof obj.pg === 'number') {
      pg = String(obj.pg);
    } else {
      throw new Error(
        `KNOWN_FAILURES.yml (${path}) entry #${index} (test=${test}) has invalid 'pg' (type ${typeof obj.pg})`,
      );
    }
    if (pg.length === 0) {
      throw new Error(
        `KNOWN_FAILURES.yml (${path}) entry #${index} (test=${test}) has empty 'pg'`,
      );
    }
  }
  return {
    test,
    scope,
    subtest: typeof obj.subtest === 'string' ? obj.subtest : undefined,
    reason,
    owner: typeof obj.owner === 'string' ? obj.owner : undefined,
    ticket: typeof obj.ticket === 'string' ? obj.ticket : undefined,
    added: typeof obj.added === 'string' ? obj.added : undefined,
    pg,
  };
}

/**
 * Filter KNOWN_FAILURES entries by the running PG major version.
 *
 * - Entries with no `pg` field always apply (legacy / cross-version).
 * - Entries with `pg: '14'` only apply when `serverPgMajor === '14'`.
 * - When `serverPgMajor` is undefined (no env var set), every entry
 *   applies — same as the legacy behaviour.
 */
export function filterByPgMajor(
  entries: readonly KnownFailureEntry[],
  serverPgMajor: string | undefined,
): KnownFailureEntry[] {
  if (serverPgMajor === undefined) {
    return [...entries];
  }
  return entries.filter((e) => e.pg === undefined || e.pg === serverPgMajor);
}

/**
 * Find a KNOWN_FAILURES entry matching the given test invocation, or
 * `undefined` if none. Subtest entries are matched by (test, subtest);
 * full-file entries match any subtest of that test.
 */
export function findKnownFailure(
  input: ExpectInput,
  entries: readonly KnownFailureEntry[],
): KnownFailureEntry | undefined {
  for (const e of entries) {
    if (e.test !== input.testName) continue;
    if (e.scope === 'full-file') return e;
    if (e.scope === 'subtest' && e.subtest === input.subtestName) return e;
  }
  return undefined;
}

/**
 * Apply the 4-quadrant truth table. On a regression or unexpected
 * failure, throws `Error`. Returns the resolved outcome on success.
 *
 * Per-PG-version entries (`pg: '14'`) are filtered against
 * `$PGCONFORMANCE_PG_MAJOR` before the table is evaluated, so a PG-18
 * waiver does not mask a regression on PG 14.
 *
 * @param knownFailuresPath override path; default is
 *                          tests/psql-conformance/KNOWN_FAILURES.yml
 * @param serverPgMajor     override the env-derived PG major (for tests)
 */
export function expectMatches(
  input: ExpectInput,
  knownFailuresPath?: string,
  serverPgMajor: string | undefined = process.env.PGCONFORMANCE_PG_MAJOR,
): ExpectOutcome {
  const allEntries = loadKnownFailures(knownFailuresPath);
  const entries = filterByPgMajor(allEntries, serverPgMajor);
  const entry = findKnownFailure(input, entries);
  const label = describeTarget(input);

  if (input.actualOutcome === 'pass') {
    if (entry) {
      throw new Error(
        `REGRESSION: ${label} now passes, but KNOWN_FAILURES.yml still ` +
          `contains an entry for it (reason: "${entry.reason}"). Remove ` +
          `that entry from tests/psql-conformance/KNOWN_FAILURES.yml.`,
      );
    }
    return { kind: 'pass' };
  }

  // actualOutcome === 'fail'
  if (entry) {
    return { kind: 'expected-failure', entry };
  }
  const msg = input.failureMessage ?? '(no failure message)';
  throw new Error(`${label} failed: ${msg}`);
}

function describeTarget(input: ExpectInput): string {
  return input.subtestName
    ? `${input.testName} :: ${input.subtestName}`
    : input.testName;
}
