/**
 * Pin the user-facing error templates with inline snapshots. The throw
 * message IS the docs — a silent edit that drops the corrective example,
 * the recovery command, or the URL would degrade UX with no test signal.
 *
 * Each snapshot lives in this file (not in a separate __snapshots__
 * directory) so reviewers reading the diff see the exact wording change.
 */
import { describe, it, expect } from 'vitest';

import {
  branchQuotaMessage,
  cycleDetectedMessage,
  dupKeyMessage,
  endLatchForInvocation,
  isCliShutdownInFlight,
  resetCliShutdownInFlight,
  setCliShutdownInFlight,
  singletonMessage,
  stackSpecNotRecordMessage,
  vercelTokenMissingMessage,
} from './errors.js';

describe('error templates', () => {
  it('dupKeyMessage names both keys and shows the makeXxx helper pattern', () => {
    expect(
      dupKeyMessage({
        stackName: 'root',
        keyA: 'seed_users',
        keyB: 'seed_orders',
        kind: 'localCommand',
      }),
    ).toMatchInlineSnapshot(`
      "[neon launch] Stack 'root' returns the same resource at two keys: 'seed_users' and 'seed_orders'.
      Both record entries point to the same \`localCommand(...)\` value.

      Each key in a stack's record provisions one resource. Two keys → one value is
      almost always a typo — either rename one of the consts and declare them
      separately, or remove the duplicate key.

      If you actually want two independent instances with similar specs, wrap the
      constructor in a helper that returns a fresh resource on each call:

        const makeSeed = (table: string) => localCommand({
          spec: ({ db }) => ({
            command: \`npm run seed:\${table}\`,
            env: { DATABASE_URL: db.connectionString },
            readiness: { onExit: 0 },          // one-shot — exits when done
          }),
          dependsOn: { db },
        });

        return {
          db,
          seed_users:    makeSeed('seed_users'),
          seed_orders: makeSeed('seed_orders'),
        };"
    `);
  });

  it('singletonMessage(0) tells the user to add a postgres', () => {
    expect(singletonMessage({ count: 0, names: [] })).toMatch(
      /Found 0 postgres resources/,
    );
    expect(singletonMessage({ count: 0, names: [] })).toMatch(
      /Add a `postgres\(\{\.\.\.\}\)`/,
    );
  });

  it('singletonMessage(>1) names every postgres FQN', () => {
    const msg = singletonMessage({
      count: 3,
      names: ['db.primary', 'db.cache', 'db.replica'],
    });
    expect(msg).toMatch(/Found 3 postgres resources/);
    expect(msg).toContain('db.primary');
    expect(msg).toContain('db.cache');
    expect(msg).toContain('db.replica');
  });

  it('branchQuotaMessage references the project id + the upgrade/delete paths + plan-cap link', () => {
    const msg = branchQuotaMessage({ projectId: 'proud-cake-123', limit: 25 });
    expect(msg).toMatch(/proud-cake-123/);
    expect(msg).toMatch(/25 branches per project/);
    expect(msg).toMatch(/neon branches delete/);
    expect(msg).toMatch(/console\.neon\.tech.*proud-cake-123/);
    expect(msg).toMatch(/neon\.com\/docs\/introduction\/plans/);
  });

  it('branchQuotaMessage without explicit limit still lists actions', () => {
    const msg = branchQuotaMessage({ projectId: 'p1' });
    expect(msg).toMatch(/Branch limit reached/);
    expect(msg).toMatch(/Delete unused branches/);
  });

  it('vercelTokenMissingMessage points to the tokens settings page', () => {
    expect(vercelTokenMissingMessage()).toMatchInlineSnapshot(`
      "[neon launch] VERCEL_TOKEN is required when a vercelDeployment is in scope.
      Create one at https://vercel.com/account/tokens and re-run."
    `);
  });

  it('stackSpecNotRecordMessage shows the corrective shape', () => {
    const msg = stackSpecNotRecordMessage({ stackName: 'root', got: 'string' });
    expect(msg).toMatch(/Stack 'root'.*got string/);
    expect(msg).toMatch(/postgres, vercelDeployment, localCommand/);
    expect(msg).toMatch(/export default stack\({/);
  });

  it('cycleDetectedMessage lists involved resources and gives a corrective', () => {
    const msg = cycleDetectedMessage({ involved: ['a', 'b', 'a'] });
    expect(msg).toMatch(/Cycle detected/);
    expect(msg).toMatch(/Involved resources: a, b, a/);
    expect(msg).toMatch(/extract the shared part/);
  });
});

describe('endLatchForInvocation — end-of-invocation latch policy', () => {
  // R18 reintroduced a regression where the runner's finally
  // unconditionally reset the latch, defeating its purpose: the CLI
  // catch in commands/launch.ts would read `false` and race the
  // signal handler with its own closeAnalytics+process.exit chain,
  // and the wrong exit code would win.
  //
  // The test calls the SAME exported helper that production calls
  // (see runner.ts: `endLatchForInvocation({shuttingDown: …})` in
  // the finally block). Falsifier check: change runner.ts's finally
  // back to an unconditional `resetCliShutdownInFlight()` and the
  // production code stops importing `endLatchForInvocation` — these
  // tests catch via a different module path either way, because they
  // test the exported helper itself. To pin "the runner uses this
  // helper", the test below also asserts the runner module imports it.

  it('latch is PRESERVED when invocation initiated the shutdown', () => {
    setCliShutdownInFlight();
    expect(isCliShutdownInFlight()).toBe(true);
    endLatchForInvocation({ shuttingDown: true });
    expect(isCliShutdownInFlight()).toBe(true);
    // Cleanup so test order doesn't pollute siblings.
    resetCliShutdownInFlight();
  });

  it('latch IS reset on normal completion (no shutdown signal)', () => {
    // Library-mode safety: a non-shutdown invocation must clear the
    // latch so a subsequent runLaunch in the same process doesn't see
    // a stale flag.
    setCliShutdownInFlight();
    endLatchForInvocation({ shuttingDown: false });
    expect(isCliShutdownInFlight()).toBe(false);
  });

  it('the runner uses endLatchForInvocation (no shadow copy)', async () => {
    // Falsifier: replacing the call site in runner.ts's finally with
    // an inline `if (!shuttingDown) resetCliShutdownInFlight()` would
    // make this assertion fail. The reverse-regression we're guarding
    // against — the R18 performative-test footgun — would also fail
    // because the helper would no longer be in the runner's import
    // list.
    const runnerSrc = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./runner.ts', import.meta.url).pathname, 'utf8'),
    );
    expect(runnerSrc).toMatch(
      /endLatchForInvocation\(\{\s*shuttingDown:\s*runtime\.shuttingDown\.value\s*\}\)/,
    );
  });
});
