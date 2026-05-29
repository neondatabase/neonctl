// Port of upstream PostgreSQL's `src/bin/psql/t/010_tab_completion.pl`.
//
// Vendored reference:
//   tests/psql-conformance/vendor/postgres-18.0/src/bin/psql/t/010_tab_completion.pl
//
// This spec drives an interactive psql session over a PTY (via `node-pty`),
// sends partial commands with embedded tabs, and asserts the resulting
// visible "command line" matches the upstream expectation. The harness
// for spawning the PTY, polling for prompts, and stripping ANSI/CSI
// escapes lives in `../harness/pty-helpers.ts`.
//
// Coverage map
// ------------
//
// The completion engine now handles (after the trailing-space + ILIKE +
// COMP_KEYWORD_CASE + schema-aware completion work):
//
//   - Trailing space after a unique completion (mirrors readline's
//     `rl_completion_append_character`).
//   - Schema namespace dot-completion (`pub<tab>` → `public.`).
//   - Case-folded catalog matching via ILIKE (`TAB<tab>` → `tab1`).
//   - COMP_KEYWORD_CASE (lower / upper / preserve-lower / preserve-upper)
//     wired into `settings.compCase` via a VarStore hook.
//   - Quoted-identifier completion (`"my<tab>` → `"mytab*`,
//     `"mi<tab>` → `"mixedName"`).
//   - Multi-candidate listing on the second Tab (engine already did
//     this — verified by the listing subtests).
//
// Filename completion (`\lo_import`, `\lo_export`, `\copy ... FROM/TO`,
// and SQL `COPY ... FROM/TO`) is now backed by the filesystem-driven
// completer in `src/psql/complete/filenames.ts`.
//
// What's still missing (and therefore still `it.todo`):
//
//   - Enum-value completion inside `'X<tab>` — needs a string-literal
//     context detector + `ALTER TYPE ... RENAME VALUE` rule.
//   - Timezone name completion — would need `pg_timezone_names` rule.
//   - Some SchemaQuery-derived keyword completions (DROP TYPE big →
//     bigint), VersionedQuery, words_after_create, plpgsql GUCs.
//   - Multi-line completion mid-statement (ANALYZE (\n\t\t).
//   - Index name completion via ALTER TABLE ... DROP CONSTRAINT.
//   - COPY ... WITH (DEFAULT) keyword in option-list context.
//
// Whatever still fails after this round stays as `it.todo` with a
// reason in the comment.
//
// What's ported
// -------------
//
//   - Every `check_completion(...)` call from upstream maps to exactly
//     one `it(...)` here, in the same order. The upstream subtest
//     description is preserved verbatim in the test name (with an
//     annotation pointing back to the line number).
//   - The setup-table block from upstream lines 41-47 is reproduced in
//     `SETUP_SQL` and runs before the PTY session opens. Includes
//     `tab1` / `mytab123` / `mytab246` / `"mixedName"` tables, the
//     `enum1` type, the `some_publication` publication, and the
//     `tab_comp_dir` directory full of dummy files.
//   - The COMP_KEYWORD_CASE block (upstream lines 309-325) is unrolled
//     into four `it()` cases.
//
// Run condition
// -------------
//
//   - Same gate as `001_basic.spec.ts` / `030_pager.spec.ts`:
//     `RUN_INTEGRATION=1` AND `dist/psql/index.js` exists. When the
//     gate is closed, the whole `describe` block is skipped; a sibling
//     describe surfaces *why* in the reporter.
//
// PSQL_BINARY override
// --------------------
//
//   - Setting `PSQL_BINARY=/usr/local/bin/psql` (or similar) makes the
//     same spec drive vanilla psql instead of our embedded TS psql.
//     This lets a maintainer sanity-check the harness itself against
//     the reference implementation. The helper picks the binary up via
//     env; no spec changes needed.
//
// Followup
// --------
//
//   - Subtests that don't yet pass against the embedded TS psql are
//     marked inline via `it.todo("<name> — <reason>")`.

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_PROMPT_RE,
  DIST_EXISTS,
  RUN_INTEGRATION,
  SHOULD_RUN_INTEGRATION,
  buildUri,
  ensureFixture,
  kill,
  makeLauncher,
  sendKeys,
  spawnPsql,
  waitForOutput,
  waitForPrompt,
  type PtyHandle,
} from '../harness/pty-helpers.js';

const SHOULD_RUN = SHOULD_RUN_INTEGRATION;

// ---------------------------------------------------------------------------
// Setup: SQL fixtures + tab_comp_dir scratch tree.
// ---------------------------------------------------------------------------

/**
 * Setup SQL that mirrors upstream lines 41-47. Run once before the PTY
 * session opens so the catalog queries triggered by Tab return the right
 * results. The DROP IF EXISTS preambles let a maintainer rerun the
 * spec against a persistent fixture (`PGCONFORMANCE_PG_HOST` pointed at
 * an external Postgres).
 */
const FIXTURE_DROP_SQL = [
  // Listed by name (not pattern) so we don't drop anything we don't
  // own. Includes a defensive drop of `tab_psql_single` from
  // `001_basic.spec.ts` — when it lingers, prefix matches like
  // `from t<tab>` (should resolve uniquely to `tab1`) degrade to
  // multi-candidate completions whose common prefix is just `tab`.
  'DROP TABLE IF EXISTS tab1 CASCADE;',
  'DROP TABLE IF EXISTS mytab123 CASCADE;',
  'DROP TABLE IF EXISTS mytab246 CASCADE;',
  'DROP TABLE IF EXISTS "mixedName" CASCADE;',
  'DROP TABLE IF EXISTS tab_psql_single CASCADE;',
  'DROP TYPE IF EXISTS enum1 CASCADE;',
  'DROP PUBLICATION IF EXISTS some_publication;',
].join('\n');

// `tenk1` (and `onek`) are seeded into every matrix container by
// `pg-fixture.ts` so the `regress/psql*` specs find them. They share the
// `t*` prefix with our `tab1`, which makes the upstream tab-completion
// assertion "`select * from t<tab>` → tab1" ambiguous (two `t*` matches).
// We drop them in this spec's setup so completion sees only our
// fixtures, then restore them in teardown so sibling specs that run
// later still find them.
const SEED_DROP_SQL = [
  'DROP TABLE IF EXISTS tenk1 CASCADE;',
  'DROP TABLE IF EXISTS onek CASCADE;',
].join('\n');

const SETUP_SQL = [
  FIXTURE_DROP_SQL,
  SEED_DROP_SQL,
  'CREATE TABLE tab1 (c1 int primary key constraint foo not null, c2 text);',
  'CREATE TABLE mytab123 (f1 int, f2 text);',
  'CREATE TABLE mytab246 (f1 int, f2 text);',
  'CREATE TABLE "mixedName" (f1 int, f2 text);',
  "CREATE TYPE enum1 AS ENUM ('foo', 'bar', 'baz', 'BLACK');",
  'CREATE PUBLICATION some_publication;',
].join('\n');

// Symmetric teardown — drop the fixtures we created and re-seed the
// regress-suite tables so sibling specs (regress/psql*, catalog-shape)
// running after us see a clean schema. The full seed script lives at
// `vendor/postgres-18.0/src/test/regress/sql/test_setup_minimal.sql`;
// we inline its CREATE TABLE / INSERT / VACUUM block here to avoid a
// file-path dependency at teardown time.
const SEED_RESTORE_SQL = [
  'CREATE TABLE onek (',
  '    unique1     int4,',
  '    unique2     int4,',
  '    two         int4, four        int4, ten         int4,',
  '    twenty      int4, hundred     int4, thousand    int4,',
  '    twothousand int4, fivethous   int4, tenthous    int4,',
  '    odd         int4, even        int4,',
  '    stringu1    name, stringu2    name, string4     name',
  ');',
  'INSERT INTO onek (unique1, unique2) SELECT i, i FROM generate_series(0, 999) AS gs(i);',
  'VACUUM ANALYZE onek;',
  'CREATE TABLE tenk1 (',
  '    unique1     int4,',
  '    unique2     int4,',
  '    two         int4, four        int4, ten         int4,',
  '    twenty      int4, hundred     int4, thousand    int4,',
  '    twothousand int4, fivethous   int4, tenthous    int4,',
  '    odd         int4, even        int4,',
  '    stringu1    name, stringu2    name, string4     name',
  ');',
  'INSERT INTO tenk1 (unique1, unique2) SELECT i, i FROM generate_series(0, 9999) AS gs(i);',
  'CREATE INDEX tenk1_unique2 ON tenk1 USING btree (unique2);',
  'VACUUM ANALYZE tenk1;',
].join('\n');

const TEARDOWN_SQL = [FIXTURE_DROP_SQL, SEED_RESTORE_SQL].join('\n');

/**
 * Mirror upstream lines 59-73: a scratch `tab_comp_dir/` with three
 * dummy files. The PTY session's cwd is set to the parent so the
 * filename-completion subtests can use relative paths exactly as
 * upstream does.
 */
const makeTabCompWorkdir = (): string => {
  const work = mkdtempSync(join(tmpdir(), 'psql-tab-complete-'));
  const dir = join(work, 'tab_comp_dir');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'somefile'), 'some stuff\n');
  writeFileSync(join(dir, 'afile123'), 'more stuff\n');
  writeFileSync(join(dir, 'afile456'), 'other stuff\n');
  return work;
};

/**
 * Push the SETUP_SQL through psql once before the PTY session. Uses
 * the same launcher mechanism as the PTY path so the dist URL is
 * resolved from the helper module's `REPO_ROOT` (not from vitest's
 * cwd, which is the conformance subdir).
 */
const runSqlScript = async (
  sql: string,
  launcherName: string,
): Promise<{ status: number | null; stderr: string }> => {
  const { spawnSync } = await import('node:child_process');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LC_ALL: 'C',
    PAGER: '',
    PSQL_PAGER: '',
  };
  const external = process.env.PSQL_BINARY ?? '';
  const uri = buildUri();
  // Same `.js`-vs-binary resolver as `pty-helpers.ts` and
  // `regress.spec.ts`: a `.js` PSQL_BINARY (our dist shim) must be
  // invoked via `node`, since the file may not have the executable bit
  // set after `tsc` emit.
  let file: string;
  let argv: string[];
  if (external === '') {
    file = process.execPath;
    argv = [makeLauncher(launcherName).launcher, uri, '-X', '-c', sql];
  } else if (external.endsWith('.js')) {
    file = process.execPath;
    argv = [external, uri, '-X', '-c', sql];
  } else {
    file = external;
    argv = [uri, '-X', '-c', sql];
  }
  const r = spawnSync(file, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, stderr: r.stderr.toString() };
};

const runSetupSql = async (): Promise<void> => {
  const r = await runSqlScript(SETUP_SQL, 'tabcomp-setup');
  if (r.status !== 0) {
    throw new Error(`setup SQL failed: exit=${r.status} stderr=${r.stderr}`);
  }
};

const runTeardownSql = async (): Promise<void> => {
  // Best-effort: a teardown failure shouldn't fail the test run; the
  // tests have already passed by this point. Log and move on so the
  // next spec sees the cleanup attempt.
  const r = await runSqlScript(TEARDOWN_SQL, 'tabcomp-teardown');
  if (r.status !== 0) {
    process.stderr.write(
      `[010_tab_completion] teardown SQL failed (continuing): exit=${r.status} stderr=${r.stderr.slice(0, 200)}\n`,
    );
  }
};

/**
 * Open a fresh PTY-bound psql session, wait for the first prompt, and
 * return the handle. Each test in this spec uses a single shared
 * session — upstream does the same.
 */
const openSession = async (workdir: string): Promise<PtyHandle> => {
  const h = await spawnPsql({
    uri: buildUri(),
    args: ['-X'],
    cwd: workdir,
  });
  await waitForPrompt(h, { timeoutMs: 15_000 });
  h.clear();
  return h;
};

// ---------------------------------------------------------------------------
// Spec body.
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)('tap/010_tab_completion', () => {
  let h: PtyHandle;
  let workdir: string;

  beforeAll(async () => {
    await ensureFixture();
    workdir = makeTabCompWorkdir();
    await runSetupSql();
    h = await openSession(workdir);
  }, 60_000);

  afterAll(async () => {
    if (h) await kill(h, 2_000);
    // Clean up the seeded fixtures so sibling specs that share the
    // matrix DB (regress/*, catalog-shape) see a clean schema. Without
    // this, `tab1`/`mytab123`/etc. linger in `pg_class` and pollute
    // `\d` / `\dT` / planner output. Mirror the SETUP_SQL DROPs.
    await runTeardownSql();
  });

  // ----- check_completion helper -----------------------------------------
  // Mirrors upstream's `check_completion($send, $pattern, $annotation)`
  // from `010_tab_completion.pl`. Sends the keystrokes (including any
  // embedded tabs), polls the visible buffer for the expected pattern,
  // and asserts the match. On failure dumps the last 500 chars of
  // cleaned output so the diagnostic is actionable.
  //
  // `waitForOutput` returns as soon as the pattern shows up, so a
  // happy-path completion typically takes <100 ms. The 5 s ceiling
  // accommodates slow catalog queries on cold-started containers (the
  // first test in the file pays the warmup cost for every `_psql_*`
  // tab-completion query the engine fans out on the very first Tab).
  const COMPLETION_TIMEOUT_MS = 5_000;
  const checkCompletion = async (
    send: string,
    pattern: RegExp,
  ): Promise<void> => {
    h.clear();
    sendKeys(h, send);
    try {
      await waitForOutput(h, pattern, COMPLETION_TIMEOUT_MS);
    } catch {
      const buf = h.clean();
      throw new Error(
        `checkCompletion: expected pattern ${pattern} to match.\n` +
          `--- last 500 chars of clean output ---\n${buf.slice(-500)}`,
      );
    }
  };

  // Reset the prompt to a clean state between checks. Mirrors upstream's
  // `clear_query()` (\r resets the in-flight query buffer) but falls back
  // to Ctrl-U + Ctrl-C if `\r` would land us mid-quote.
  const resetPrompt = async (): Promise<void> => {
    // Ctrl-C cancels any partial line; Ctrl-U kills the buffer entirely.
    sendKeys(h, '\x03');
    sendKeys(h, '\x15');
    h.clear();
    await waitForOutput(h, DEFAULT_PROMPT_RE, 5_000);
  };

  // Send a `\set` (or any other) line and wait for the next prompt to
  // appear, without checking any completion output. Used by the
  // COMP_KEYWORD_CASE subtests so we can flip the setting between cases.
  const sendCommand = async (cmd: string): Promise<void> => {
    h.clear();
    sendKeys(h, cmd + '\r');
    await waitForOutput(h, DEFAULT_PROMPT_RE, 5_000);
    h.clear();
  };

  // Reset state after every check so the next subtest starts on a clean
  // prompt. Mirrors upstream's repeated `clear_query()` calls — we just
  // do it unconditionally because every subtest in our port sends a
  // complete keystroke sequence (no inter-test chaining).
  afterEach(async () => {
    await resetPrompt();
  });

  // -------------------------------------------------------------------------
  // Harness smoke test — proves the PTY can spawn, reach a prompt,
  // accept keystrokes, and have those keystrokes flow back as echo. The
  // completion engine is exercised passively (no-completion `blarg`
  // input) so the assertion is independent of our 88-rule completion
  // set.
  //
  // This corresponds to upstream line 414:
  //   check_completion("blarg \t\t", qr//, "check completion failure path");
  // -------------------------------------------------------------------------
  it('PTY smoke: blarg <tab><tab> echoes "blarg" without crashing (line 414)', async () => {
    h.clear();
    sendKeys(h, 'blarg \t\t');
    // Allow the (no-)completion path to run.
    await new Promise<void>((r) => setTimeout(r, 300));
    const buf = h.clean();
    expect(buf).toMatch(/blarg/);
    // Reset state — Ctrl-C cancels the partial buffer.
    sendKeys(h, '\x03');
    h.clear();
    await waitForOutput(h, DEFAULT_PROMPT_RE, 5_000);
  });

  // -------------------------------------------------------------------------
  // Every upstream `check_completion(...)` from the vendored
  // 010_tab_completion.pl, in source order. Each is `it.todo` today —
  // see the file header for the rationale. Reviving any of these as a
  // real `it()` is a 5-line edit: replace `it.todo(name)` with
  // `it(name, async () => { ... })` and copy the assertion from
  // upstream into a `checkCompletion(h, send, pattern)` call.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Subtests unlocked by the trailing-space + ILIKE + COMP_KEYWORD_CASE
  // engine work. Each `it(...)` mirrors one `check_completion(...)` from
  // the vendored upstream `.pl` (the line number annotation points to the
  // exact source line).
  // -------------------------------------------------------------------------

  // Basic command completion (line 129).
  it('complete SEL<tab> to SELECT (line 129)', async () => {
    await checkCompletion('SEL\t', /SELECT /);
  });

  // Case variation honored (line 134).
  it('complete sel<tab> to select (line 134)', async () => {
    await checkCompletion('sel\t', /select /);
  });

  // Basic table name completion (line 137).
  it('complete t<tab> to tab1 in `select * from t<tab>` (line 137)', async () => {
    await checkCompletion('select * from t\t', /\* from tab1 /);
  });

  // Multiple table-name choices (lines 143-155).
  it('complete my<tab> to mytab (multiple choices, line 143)', async () => {
    // Single tab inserts the common prefix `mytab` — readline may emit a
    // bell first; upstream's pattern allows the `\a?` BEL escape.
    await checkCompletion('select * from my\t', /select \* from my\a?tab/);
  });

  it('offer multiple table choices on <tab><tab> — `mytab123 mytab246` listing (line 149)', async () => {
    // Sequence: send the initial `my\t` prefix, then a second `\t\t` so the
    // candidate listing renders below the prompt.
    h.clear();
    sendKeys(h, 'select * from my\t\t\t');
    await new Promise<void>((r) => setTimeout(r, 500));
    const buf = h.clean();
    expect(buf).toMatch(/mytab123\s+mytab246/);
  });

  // Quoted names (lines 160-171).
  it('complete "my<tab> to "mytab (line 160)', async () => {
    await checkCompletion('select * from "my\t', /select \* from "my\a?tab/);
  });

  it('offer multiple quoted table choices on <tab><tab> (line 165)', async () => {
    h.clear();
    sendKeys(h, 'select * from "my\t\t\t');
    await new Promise<void>((r) => setTimeout(r, 500));
    const buf = h.clean();
    expect(buf).toMatch(/"mytab123"\s+"mytab246"/);
  });

  // Mixed-case names (line 176).
  it('complete a mixed-case name — "mi<tab> → "mixedName" (line 176)', async () => {
    await checkCompletion('select * from "mi\t', /"mixedName" /);
  });

  // Case folding (line 184).
  it('automatically fold case — TAB<tab> → tab1 (line 184)', async () => {
    await checkCompletion('select * from TAB\t', /tab1 /);
  });

  // Case-sensitive backslash command replacement (line 191).
  it('complete \\DRD<tab> to \\drds (line 191)', async () => {
    await checkCompletion('\\DRD\t', /drds /);
  });

  // Schema-qualified name (lines 196-206).
  it('complete schema when relevant — pub<tab> → public. (line 196)', async () => {
    // `pub<tab>` resolves to `public.` because the unqualified prefix
    // matches a schema (no relations start with `pub`). The trailing dot
    // is "in progress" — the editor must not append a space after it.
    await checkCompletion('select * from pub\t', /public\./);
  });

  it('complete schema-qualified name — public.tab<tab> → public.tab1 (line 199)', async () => {
    // Sent in one keystroke sequence so the schema-qualified completion
    // fires on the user-typed `public.tab` rather than chaining on
    // a previous test's state.
    await checkCompletion('select * from public.tab\t', /public\.tab1 /);
  });

  it('automatically fold case in schema-qualified name — PUBLIC.t<tab> (line 203)', async () => {
    await checkCompletion('select * from PUBLIC.t\t', /public\.tab1 /);
  });

  // COMP_KEYWORD_CASE table (lines 309-325). Four cases unrolled.
  // Each subtest flips the variable via `\set`, exercises the
  // completion, and (via afterEach) resets the prompt for the next.
  // Upstream sends three tabs (\t\t\t) so the cycle path lands on a
  // concrete keyword — first tab inserts the common prefix, second lists
  // the candidates, third cycles to the first concrete candidate (which
  // is what the pattern matches).
  it('COMP_KEYWORD_CASE=lower: `alter table tab1 rename CO<tab>` → column (line 309 case A)', async () => {
    await sendCommand('\\set COMP_KEYWORD_CASE lower');
    await checkCompletion('alter table tab1 rename CO\t\t\t', /column/);
    // Reset to default after the test so the next subtest sees
    // preserve-upper. afterEach handles prompt reset, but compCase
    // persists in psql state — so unset explicitly here.
    await sendCommand('\\set COMP_KEYWORD_CASE preserve-upper');
  });

  it('COMP_KEYWORD_CASE=upper: `alter table tab1 rename co<tab>` → COLUMN (line 309 case B)', async () => {
    await sendCommand('\\set COMP_KEYWORD_CASE upper');
    await checkCompletion('alter table tab1 rename co\t\t\t', /COLUMN/);
    await sendCommand('\\set COMP_KEYWORD_CASE preserve-upper');
  });

  it('COMP_KEYWORD_CASE=preserve-lower: `alter table tab1 rename co<tab>` → column (line 309 case C)', async () => {
    await sendCommand('\\set COMP_KEYWORD_CASE preserve-lower');
    await checkCompletion('alter table tab1 rename co\t\t\t', /column/);
    await sendCommand('\\set COMP_KEYWORD_CASE preserve-upper');
  });

  it('COMP_KEYWORD_CASE=preserve-upper: `alter table tab1 rename CO<tab>` → COLUMN (line 309 case D)', async () => {
    // Default mode — no flip needed.
    await checkCompletion('alter table tab1 rename CO\t\t\t', /COLUMN/);
  });

  // -------------------------------------------------------------------------
  // Subtests that still depend on rules/contexts our 88-rule engine
  // doesn't implement yet. Left as `it.todo` with a precise reason so
  // a follow-up agent can pick exactly the next gap.
  // -------------------------------------------------------------------------

  // The `mytab123` listing then `2<tab>` follow-up is testing cycle-and-
  // commit semantics that depend on knowing the current cycle index from
  // the previous tap. Our `CompletionState` does cycle, but the "type 2
  // after the listing" path requires the in-progress buffer to become
  // `mytab2` and then re-trigger as a single-candidate match — which
  // works in isolation but is hard to express here without a chained
  // session.
  it.todo(
    'finish one of multiple table choices — `2<tab>` → `246 ` (line 154; needs chained session state)',
  );
  it.todo(
    'finish one of multiple quoted choices — `2<tab>` → `246" ` (line 170; needs chained session state)',
  );

  // Index name for referenced table (lines 211-228). Upstream's
  // tab-complete.in.c parses `ALTER TABLE x DROP CONSTRAINT y` and offers
  // index/constraint names of `x`; our engine has no constraint-name
  // completion at all.
  it.todo(
    'complete index name for referenced table — `alter table tab1 drop constraint t<tab>` → tab1_pkey (line 211; needs ALTER TABLE … DROP CONSTRAINT rule)',
  );
  it.todo(
    'complete index name for referenced table, with downcasing — TAB1 (line 218; same gap)',
  );
  it.todo(
    'complete index name for referenced table, with schema and quoting — public."tab1" (line 225; same gap)',
  );

  // Qualified name from object reference (line 234) — multi-line tab
  // completion that uses the COMMENT ON CONSTRAINT context to resolve
  // the schema/object the user references. Not in our 88 rules.
  it.todo(
    'complete qualified name from object reference — `comment on constraint ... on public.<tab>` (line 234; needs COMMENT ON CONSTRAINT rule + multi-line context)',
  );

  // Filename completion (lines 242-277). Backed by the filesystem-driven
  // completer in `src/psql/complete/filenames.ts`. The PTY session's cwd
  // is the tmp workdir created by `makeTabCompWorkdir`, which seeds
  // `tab_comp_dir/{somefile,afile123,afile456}`.
  it('filename completion with one possibility — \\lo_import tab_comp_dir/some<tab> (line 242)', async () => {
    await checkCompletion(
      '\\lo_import tab_comp_dir/some\t',
      /tab_comp_dir\/somefile /,
    );
  });

  it('filename completion with multiple possibilities — \\lo_import tab_comp_dir/af<tab> (line 250)', async () => {
    // Single tab inserts the common prefix `tab_comp_dir/afile`. Bell may
    // precede it (\a) — upstream's pattern allows that.
    await checkCompletion(
      '\\lo_import tab_comp_dir/af\t',
      /tab_comp_dir\/af\a?ile/,
    );
  });

  it('quoted filename completion with one possibility — COPY FROM tab_comp_dir/some<tab> (line 259)', async () => {
    // SQL `COPY` requires a string literal — our completer wraps the
    // unique candidate in single quotes and the editor appends a trailing
    // space since the quotes are balanced.
    await checkCompletion(
      'COPY foo FROM tab_comp_dir/some\t',
      /'tab_comp_dir\/somefile' /,
    );
  });

  it('quoted filename completion with multiple possibilities — COPY FROM tab_comp_dir/af<tab> (line 266)', async () => {
    // Multi-candidate common prefix: opening quote only, no closing quote
    // yet (user is still typing inside the string literal).
    await checkCompletion(
      'COPY foo FROM tab_comp_dir/af\t',
      /'tab_comp_dir\/afile/,
    );
  });

  it('offer multiple file choices on <tab><tab> (line 274)', async () => {
    // Empty basename prefix at `tab_comp_dir/` — second Tab renders the
    // listing under the prompt. The formatted columns lay out the three
    // candidates with full paths; we match the three basenames in order
    // across the formatted row(s).
    h.clear();
    sendKeys(h, '\\lo_import tab_comp_dir/\t\t');
    await new Promise<void>((r) => setTimeout(r, 500));
    const buf = h.clean();
    expect(buf).toMatch(/afile123[\s\S]*afile456[\s\S]*somefile/);
  });

  // Enum label completion (lines 284-295). Needs the `ALTER TYPE ...
  // RENAME VALUE 'X<tab>` rule + a string-literal context detector
  // (so that the `'` quote opens a value completer rather than running
  // the SQL keyword rules).
  it.todo(
    "offer multiple enum choices — ALTER TYPE enum1 RENAME VALUE 'ba<tab><tab> (line 284; needs ALTER TYPE … RENAME VALUE + enum rule)",
  );
  it.todo(
    "enum labels are case sensitive — ALTER TYPE enum1 RENAME VALUE 'B<tab> → BLACK (line 292; same gap)",
  );

  // Timezone name completion (lines 300-303). Would need a
  // `pg_timezone_names` query-driven rule.
  it.todo(
    "offer partial timezone name — SET timezone TO am<tab> → 'America/ (line 300; needs pg_timezone_names rule)",
  );
  it.todo(
    'complete partial timezone name — new_<tab> → New_York (line 303; needs pg_timezone_names rule)',
  );

  // SchemaQuery keyword + create_command_generator (lines 328-339).
  // The DROP TYPE → bigint case wants type-name completion to include
  // built-in scalar keywords (mirrors upstream's
  // `Keywords_for_list_of_datatypes`). CREATE TY → TYPE still needs the
  // CREATE multi-word generator (handled in a separate commit).
  it('offer keyword from SchemaQuery — DROP TYPE big<tab> → DROP TYPE bigint (line 328)', async () => {
    await checkCompletion('DROP TYPE big\t', /DROP TYPE bigint /);
  });
  it('check create_command_generator — CREATE TY<tab> → CREATE TYPE (line 336)', async () => {
    // The existing `TailMatches(['CREATE'])` arm filters CREATE_OBJECTS
    // by the in-progress current word — `TY` resolves uniquely to
    // `TYPE`, mirroring upstream's `create_command_generator` walking
    // the `words_after_create[]` table.
    await checkCompletion('CREATE TY\t', /CREATE TYPE /);
  });

  // words_after_create (line 344). CREATE TABLE <prefix> surfaces
  // existing table names as a HINT (the user can pick a similar name
  // as a starting point). The rule mirrors upstream's
  // `words_after_create` fallback dispatching to `Query_for_list_of_tables`
  // when the prev_wd is `TABLE`.
  it('check words_after_create — CREATE TABLE mytab<tab><tab> → mytab123 + mytab246 (line 344)', async () => {
    // First Tab inserts the common prefix `mytab`, second prints the
    // candidate listing below the prompt.
    h.clear();
    sendKeys(h, 'CREATE TABLE mytab\t\t\t');
    await new Promise<void>((r) => setTimeout(r, 500));
    const buf = h.clean();
    expect(buf).toMatch(/mytab123\s+mytab246/);
  });

  // VersionedQuery (line 352). Two-step completion DROP PUBLIC<tab> →
  // DROP PUBLICATION, then publication name. We have the publication
  // name rule but not the first-step "DROP PUBLIC" keyword detection.
  it.todo(
    'check VersionedQuery — DROP PUBLIC<tab>...<tab><tab> → DROP PUBLICATION some_publication (line 352; needs DROP keyword first-tab + VersionedQuery rule)',
  );

  // Multi-line completion / ANALYZE ( (line 360). Tab completion mid-
  // statement after an `(` on its own line — our tokenizer treats
  // unclosed `(` differently than upstream's multi-statement parser.
  it.todo(
    'check ANALYZE (VERBOSE ... — multi-line completion of `analyze (` (line 360; needs ANALYZE-option rule + multi-line context)',
  );

  // GUC completion (lines 366-387). We support unqualified GUC names
  // via `Query_for_list_of_set_vars`; the failing cases are around
  // qualified GUCs (`plpgsql.variable_conflict`) and value completion
  // (`iso<tab>` → `iso_8601`), neither of which has a rule today.
  // `set interval<tab>` → `intervalstyle ` is correct (unique GUC),
  // and the second tab DOES insert `to` — but in lowercase. Upstream
  // expects `TO` uppercase. The discrepancy is in our preserve-upper
  // case-folding for the empty-input case: we fall back to lowercase
  // (see filterAndCase in src/psql/complete/rules.ts line 898),
  // upstream falls back to uppercase. Engine-level fix; left as
  // `it.todo` until that case-folding behavior is reconciled.
  it.todo(
    'complete a GUC name — set interval<tab><tab> → intervalstyle TO (line 366; engine: empty-input preserve-upper case-folding diverges from upstream)',
  );
  it.todo(
    'complete a GUC enum value — iso<tab> → iso_8601 (line 370; needs GUC-value completion)',
  );
  it.todo(
    'load plpgsql extension — `DO $$begin end$$ LANGUAGE plpgsql;` (line 376; setup-only, not a completion check)',
  );
  it.todo(
    'complete prefix of a GUC name — set plpg<tab> → plpgsql. (line 380; needs qualified-GUC rule)',
  );
  it.todo(
    'complete a qualified GUC name — var<tab><tab> → variable_conflict TO (line 382; needs qualified-GUC rule)',
  );
  it.todo(
    'complete a qualified GUC enum value — USE_C<tab> → use_column (line 386; needs qualified-GUC value rule)',
  );

  // psql variable completion (lines 392-410). `\set VERB<tab>` works
  // via our SPECIAL_VARIABLES list (VERBOSITY is in there), and
  // `def<tab>` works because `\set <var> def<tab>` triggers the value
  // completion. But `\echo :VERB<tab>` needs the interpolated-variable
  // rule (we have basic `:` expansion but the interpolation context
  // around `\echo` doesn't trigger it correctly today), and `:{?VERB<tab>`
  // needs a separate test-form rule.
  // `\set VERB<tab>` → `\set VERBOSITY ` — the SPECIAL_VARIABLES list
  // contains VERBOSITY; our rule produces the right output. Upstream
  // matches `qr/VERBOSITY /` (with the trailing space the engine
  // appends after a unique match).
  it('complete a psql variable name — \\set VERB<tab> → VERBOSITY (line 392)', async () => {
    await checkCompletion('\\set VERB\t', /VERBOSITY /);
  });
  // After `\set VERBOSITY` is typed, `def<tab>` resolves to `default`
  // via the var-value completion (the ON_ERROR_ROLLBACK / VERBOSITY
  // value table includes `default`). Send the whole sequence in one
  // call so it doesn't chain on prior test state.
  it('complete a psql variable value — \\set VERBOSITY def<tab> → default (line 394)', async () => {
    await checkCompletion('\\set VERBOSITY def\t', /default /);
  });
  it.todo(
    'complete interpolated psql variable name — \\echo :VERB<tab> → :VERBOSITY (line 398; needs `:`-interpolation context)',
  );
  it.todo(
    'complete a psql variable test — \\echo :{?VERB<tab> → :{?VERBOSITY} (line 406; needs `:{?…}` syntax support)',
  );

  // COPY FROM WITH (DEFAULT) (line 419). Needs a COPY-options rule that
  // recognises the `WITH (…)` option list; our COPY rule stops at the
  // `FROM/TO` direction selector.
  it.todo(
    'COPY FROM with DEFAULT completion — `COPY foo FROM stdin WITH ( DEF<tab>)` → DEFAULT (line 419; needs COPY ... WITH option rule)',
  );
});

// ---------------------------------------------------------------------------
// Skip guard — always runs. Mirrors the pattern in 001_basic.spec.ts.
// ---------------------------------------------------------------------------

describe('tap/010_tab_completion: skip guard', () => {
  it('reports the resolved run condition', () => {
    expect(typeof RUN_INTEGRATION).toBe('boolean');
    expect(typeof DIST_EXISTS).toBe('boolean');
    expect(typeof SHOULD_RUN_INTEGRATION).toBe('boolean');
  });

  it('records that the spec exists even when its body is gated off', () => {
    expect(true).toBe(true);
    // Touch existsSync so the import isn't flagged unused by tsc when
    // the spec body is gated off.
    void existsSync(process.cwd());
  });
});
