// Per-PG catalog-shape smoke tests for version-gated describe commands.
//
// Why this exists. `describe/queries.ts` has ~60 `serverAtLeast(...)`
// branches that emit different SQL per PG major. The unit test suite in
// `src/psql/describe/queries.test.ts` pins each branch with a snapshot
// (pg17 and pg18), but a snapshot only proves the SQL string is what we
// expect — it doesn't prove that the SQL actually runs on the
// corresponding PG version, nor that the printer renders the resulting
// (smaller / larger / differently-shaped) result-set correctly.
//
// A wrong gate (e.g. `PG_17` instead of `PG_18`) would happily pass the
// pg18 snapshot but blow up at runtime against a live PG 17 server with
// "column \"proleakproof\" does not exist" or similar. This spec catches
// that: it drives the built `dist/psql/cli.js` against the matrix
// container and asserts per-PG column-header invariants for the
// PG-18-only feature set the compatibility index calls out.
//
// Coverage is intentionally narrow: ~10 commands × 5 PGs. Picking every
// version-gated builder would balloon the matrix runtime; the chosen
// commands cover every PG-18-added column / row we documented.

import { beforeAll, describe, expect, it } from 'vitest';

import {
  RUN_INTEGRATION,
  DIST_EXISTS,
  buildUri,
  ensureFixture,
  makeLauncher,
  runChild,
  type LauncherPaths,
  type RunResult,
} from './tap/_helpers.js';
import { getPgConn } from './harness/pg-fixture.js';

const SHOULD_RUN = RUN_INTEGRATION && DIST_EXISTS;

/**
 * Run a single `-c` slash command and return the captured stdout/stderr.
 * Tests downstream parse stdout for column-header presence.
 */
const runMetaCommand = async (
  paths: LauncherPaths,
  uri: string,
  cmd: string,
): Promise<RunResult> =>
  runChild({
    launcher: paths.launcher,
    argv: [uri, '-X', '-c', cmd],
  });

/**
 * Pick the first table-header line out of psql's aligned output —
 * the one starting with one or more spaces followed by a column name.
 * Returns the pipe-split, trimmed column list. Throws if no header is
 * found (caller can assert that as a separate failure).
 */
const extractHeader = (stdout: string): string[] => {
  const lines = stdout.split('\n');
  // Skip leading title/blank lines; the header is the first line
  // containing ` | ` and not starting with `-` or `(`.
  for (const line of lines) {
    if (
      line.includes(' | ') &&
      !line.startsWith('-') &&
      !line.startsWith('(')
    ) {
      return line.split('|').map((c) => c.trim());
    }
  }
  throw new Error(`no table header found in:\n${stdout}`);
};

describe.skipIf(!SHOULD_RUN)(
  'catalog-shape (per-PG version-gated describes)',
  () => {
    let paths: LauncherPaths;
    let uri: string;
    let pgMajor: number;

    beforeAll(async () => {
      await ensureFixture();
      const conn = getPgConn();
      if (conn.serverMajor === null) {
        throw new Error('pg-fixture did not surface server major version');
      }
      pgMajor = conn.serverMajor;
      paths = makeLauncher('catalog-shape');
      uri = buildUri();

      // Seed minimal catalog state. `\dAo+` and `\dAp` need an opfamily;
      // `btree array_ops` ships with the server. `\df+ pg_catalog.now()`
      // and `\dx` operate on built-in catalog state. `\dRp+` is safe with
      // no publications.
      const r = await runChild({
        launcher: paths.launcher,
        argv: [
          uri,
          '-X',
          '-c',
          'CREATE TABLE IF NOT EXISTS catalog_shape_smoke (a int)',
        ],
      });
      if (r.exitCode !== 0) {
        throw new Error(`seed CREATE TABLE failed: ${r.stderr}`);
      }
    });

    /* ------------------------------------------------------------------- *
     *  PG-18-only columns                                                  *
     * ------------------------------------------------------------------- */

    it('\\dAo+ adds "Leakproof?" column on PG 18+', async () => {
      const r = await runMetaCommand(
        paths,
        uri,
        '\\dAo+ btree array_ops|float_ops',
      );
      expect(r.stderr).toBe('');
      expect(r.exitCode).toBe(0);
      const header = extractHeader(r.stdout);
      if (pgMajor >= 18) {
        expect(header).toContain('Leakproof?');
      } else {
        expect(header).not.toContain('Leakproof?');
        expect(header).toContain('Sort opfamily');
      }
    });

    it('\\df+ adds "Leakproof?" column on PG 18+', async () => {
      const r = await runMetaCommand(
        paths,
        uri,
        '\\df+ pg_catalog.lower(text)',
      );
      expect(r.stderr).toBe('');
      expect(r.exitCode).toBe(0);
      const header = extractHeader(r.stdout);
      if (pgMajor >= 18) {
        expect(header).toContain('Leakproof?');
      } else {
        expect(header).not.toContain('Leakproof?');
      }
      // The Security column predates PG 18 and is always present on `\df+`.
      expect(header).toContain('Security');
    });

    it('\\dRp+ adds "Generated columns" column on PG 18+', async () => {
      const r = await runMetaCommand(
        paths,
        uri,
        '\\dRp+ "no.such.publication"',
      );
      expect(r.stderr).toBe('');
      expect(r.exitCode).toBe(0);
      const header = extractHeader(r.stdout);
      if (pgMajor >= 18) {
        expect(header).toContain('Generated columns');
      } else {
        expect(header).not.toContain('Generated columns');
      }
      // `Via root` (PG 13+) is always present for the supported window.
      expect(header).toContain('Via root');
    });

    it('\\dx adds "Default version" column on PG 18+', async () => {
      const r = await runMetaCommand(paths, uri, '\\dx');
      expect(r.stderr).toBe('');
      expect(r.exitCode).toBe(0);
      const header = extractHeader(r.stdout);
      if (pgMajor >= 18) {
        expect(header).toContain('Default version');
      } else {
        expect(header).not.toContain('Default version');
      }
      expect(header).toContain('Version');
    });

    /* ------------------------------------------------------------------- *
     *  PG-18-only rows                                                     *
     * ------------------------------------------------------------------- */

    it('\\dAp pg_catalog.uuid_ops surfaces uuid_skipsupport row only on PG 18+', async () => {
      const r = await runMetaCommand(paths, uri, '\\dAp * pg_catalog.uuid_ops');
      expect(r.stderr).toBe('');
      expect(r.exitCode).toBe(0);
      if (pgMajor >= 18) {
        expect(r.stdout).toContain('uuid_skipsupport');
      } else {
        expect(r.stdout).not.toContain('uuid_skipsupport');
      }
      // uuid_cmp predates the support function rework and is always present.
      expect(r.stdout).toContain('uuid_cmp');
    });

    /* ------------------------------------------------------------------- *
     *  Smoke checks — exit 0 + non-empty stdout on every supported PG.     *
     *  These don't check shape, just that the version-gated branch         *
     *  produces a runnable query.                                          *
     * ------------------------------------------------------------------- */

    it.each([
      '\\d catalog_shape_smoke',
      '\\dT pg_catalog.int4',
      '\\dn+',
      '\\dl',
      '\\dy',
      '\\dRs',
      '\\dAc btree array_ops',
    ])('smoke: %s exits 0 with output', async (cmd) => {
      const r = await runMetaCommand(paths, uri, cmd);
      expect(r.stderr, `stderr from ${cmd}`).toBe('');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.length).toBeGreaterThan(0);
    });
  },
);

// Sibling describe — surfaces *why* we skipped when we did. Mirrors the
// pattern used by other TAP specs so the rollup metric is honest.
describe('catalog-shape: skip guard', () => {
  if (!RUN_INTEGRATION) {
    it.skip('skipped: RUN_INTEGRATION != 1', () => {
      /* unreachable */
    });
  } else if (!DIST_EXISTS) {
    it.skip('skipped: dist/psql missing — run `bun run build`', () => {
      /* unreachable */
    });
  } else {
    it('gates open: RUN_INTEGRATION=1, dist present', () => {
      expect(SHOULD_RUN).toBe(true);
    });
  }
});
