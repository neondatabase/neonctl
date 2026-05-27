/**
 * Plan-time invariant tests — every error template must fire from a
 * realistic config shape. Catches the most common ways users break the
 * stack/record/dep contract.
 */
import { describe, it, expect } from 'vitest';

import { postgres, localCommand, stack, vercelDeployment } from './config.js';
import { ExitCode } from './errors.js';
import { isInternalResource } from './plan.js';
import type { LaunchContext } from './config.js';

/**
 * Assert that a buildPlan promise rejects with a LaunchError whose
 * message matches the regex AND whose exitCode matches the expected
 * value. Every plan-time invariant must use this — message-only
 * matching doesn't catch an accidental swap to `throw new Error(...)`
 * (which would silently exit 1 instead of 2, breaking the documented
 * exit-code contract).
 */
async function expectPlanError(
  promise: Promise<unknown>,
  matcher: RegExp,
  exitCode: number = ExitCode.CONFIG_ERROR,
): Promise<void> {
  await expect(promise).rejects.toThrowError(
    expect.objectContaining({
      message: expect.stringMatching(matcher),
      exitCode,
    }),
  );
}

const ctx: LaunchContext = {
  gitBranch: 'main',
  flags: {},
  processEnv: {},
};

describe('plan invariants', () => {
  it('singleton postgres — 0 postgres throws', async () => {
    const root = stack({
      spec: () => ({
        seed: localCommand({
          spec: () => ({
            command: 'echo seed',
            readiness: { onExit: 0 },
          }),
        }),
      }),
    });
    if (!isInternalResource(root)) throw new Error('test setup wrong');
    const { buildPlan } = await import('./plan.js');
    const tmpPath = await writeTempConfig(root);
    await expectPlanError(
      buildPlan(tmpPath, ctx),
      /Found 0 postgres resources/,
    );
  });

  it('singleton postgres — 2 postgres throws with FQNs', async () => {
    const root = stack({
      spec: () => {
        const a = postgres({ spec: () => ({ name: 'a' }) });
        const b = postgres({ spec: () => ({ name: 'b' }) });
        return { a, b };
      },
    });
    const tmpPath = await writeTempConfig(root);
    const { buildPlan } = await import('./plan.js');
    await expectPlanError(
      buildPlan(tmpPath, ctx),
      /Found 2 postgres resources/,
    );
  });

  it('dup-key — same resource at two keys throws with both keys named', async () => {
    const root = stack({
      spec: () => {
        const db = postgres({ spec: () => ({ name: 'one' }) });
        return { db, also_db: db };
      },
    });
    const tmpPath = await writeTempConfig(root);
    const { buildPlan } = await import('./plan.js');
    await expectPlanError(
      buildPlan(tmpPath, ctx),
      /returns the same resource at two keys/,
    );
  });

  it('happy path — single postgres builds plan with one node', async () => {
    const root = stack({
      spec: () => {
        const db = postgres({ spec: () => ({ name: 'main' }) });
        return { db };
      },
    });
    const tmpPath = await writeTempConfig(root);
    const { buildPlan } = await import('./plan.js');
    const plan = await buildPlan(tmpPath, ctx);
    expect(plan.registry.size).toBe(1);
    expect(plan.order).toEqual(['db']);
    // The resolved spec is recorded on the node — verify the contents
    // round-trip and the kind is preserved.
    const node = plan.registry.get('db');
    expect(node?.resource.__kind).toBe('postgres');
    expect((node?.spec as { name: string }).name).toBe('main');
  });

  it('spec callback receives ctx — ctx.gitBranch flows into resolved spec', async () => {
    const root = stack({
      spec: () => {
        const db = postgres({
          spec: (_, ctx) => ({
            name: ctx.gitBranch === 'main' ? 'prod' : `dev-${ctx.gitBranch}`,
          }),
        });
        return { db };
      },
    });
    const ctxFeature: LaunchContext = {
      gitBranch: 'feature-x',
      flags: { ci: 'true' },
      processEnv: { CI: 'true' },
    };
    const tmpPath = await writeTempConfig(root);
    const { buildPlan } = await import('./plan.js');
    const plan = await buildPlan(tmpPath, ctxFeature);
    expect((plan.registry.get('db')?.spec as { name: string }).name).toBe(
      'dev-feature-x',
    );
  });

  it('dep order — postgres before localCommand', async () => {
    const root = stack({
      spec: () => {
        const db = postgres({ spec: () => ({ name: 'main' }) });
        const cmd = localCommand({
          dependsOn: { db },
          spec: ({ db }) => ({
            command: 'echo hello',
            env: { DATABASE_URL: db.connectionString },
            readiness: { onExit: 0 },
          }),
        });
        return { db, cmd };
      },
    });
    const tmpPath = await writeTempConfig(root);
    const { buildPlan } = await import('./plan.js');
    const plan = await buildPlan(tmpPath, ctx);
    expect(plan.order).toEqual(['db', 'cmd']);
    const cmdNode = plan.registry.get('cmd');
    expect(cmdNode?.deps).toEqual(['db']);
  });

  it('default export not a stack — throws with kind label', async () => {
    // Write a config that default-exports a postgres, not a stack.
    const tmpPath = await writeTempConfig(
      postgres({ spec: () => ({ name: 'x' }) }),
    );
    const { buildPlan } = await import('./plan.js');
    await expectPlanError(
      buildPlan(tmpPath, ctx),
      /default-export a stack.*Found: postgres/s,
    );
  });

  it('vercel-deployment with postgres dep — orders postgres first', async () => {
    const root = stack({
      spec: () => {
        const db = postgres({ spec: () => ({ name: 'main' }) });
        const web = vercelDeployment({
          dependsOn: { db },
          spec: ({ db }) => ({
            project: 'my-app',
            env: { DATABASE_URL: db.connectionString },
          }),
        });
        return { db, web };
      },
    });
    const tmpPath = await writeTempConfig(root);
    const { buildPlan } = await import('./plan.js');
    const plan = await buildPlan(tmpPath, ctx);
    expect(plan.order).toEqual(['db', 'web']);
  });

  it('nested stack rejected with actionable error pointing at inline workaround', async () => {
    const inner = stack({
      spec: () => {
        const db = postgres({ spec: () => ({ name: 'a' }) });
        return { db };
      },
    });
    const root = stack({
      // The TS-level `Resource<'stack', never>` change makes the nested
      // pattern a type error too — but at runtime we still need the
      // friendly throw for users who silenced the type check.
      spec: () => ({ inner }) as never,
    });
    const tmpPath = await writeTempConfig(root);
    const { buildPlan } = await import('./plan.js');
    await expectPlanError(
      buildPlan(tmpPath, ctx),
      /Nested stacks are not supported in v1/,
    );
  });

  it('dep not in tree throws with the resource name and the missing key', async () => {
    const orphan = postgres({ spec: () => ({ name: 'orphan' }) });
    const root = stack({
      spec: () => {
        const db = postgres({ spec: () => ({ name: 'main' }) });
        const cmd = localCommand({
          dependsOn: { orphan },
          spec: ({ orphan }) => ({
            command: 'echo hi',
            env: { X: orphan.host },
            readiness: { onExit: 0 },
          }),
        });
        return { db, cmd };
      },
    });
    const tmpPath = await writeTempConfig(root);
    const { buildPlan } = await import('./plan.js');
    await expectPlanError(
      buildPlan(tmpPath, ctx),
      /depends on 'orphan'.*not in the resolved tree/s,
    );
  });

  it('localCommand with dependents but no readiness is rejected at plan time', async () => {
    const root = stack({
      spec: () => {
        const db = postgres({ spec: () => ({ name: 'main' }) });
        const migrate = localCommand({
          // intentionally no readiness — should trigger the new invariant
          spec: () => ({ command: 'npm run db:migrate' }),
        });
        const dev = localCommand({
          dependsOn: { db, migrate },
          spec: ({ db }) => ({
            command: 'npm run dev',
            env: { DATABASE_URL: db.connectionString },
            readiness: { httpGet: { url: 'http://localhost:3000' } },
          }),
        });
        return { db, migrate, dev };
      },
    });
    const tmpPath = await writeTempConfig(root);
    const { buildPlan } = await import('./plan.js');
    await expectPlanError(
      buildPlan(tmpPath, ctx),
      /localCommand 'migrate' has dependents but no `readiness`/,
    );
  });

  it('cycle in dependencies throws cycleDetectedMessage with involved resources', async () => {
    // Cycles can't be constructed through the factories (forward
    // reference required), so build the back-edge by mutating
    // __dependsOn after both resources exist.
    const a = postgres({ spec: () => ({ name: 'main' }) });
    const b = localCommand({
      dependsOn: { a },
      spec: ({ a }) => ({
        command: 'echo hi',
        env: { X: a.host },
        readiness: { onExit: 0 },
      }),
    });
    // Inject the back-edge b → a.
    (a as unknown as { __dependsOn: Record<string, unknown> }).__dependsOn = {
      b,
    };
    const root = stack({ spec: () => ({ a, b }) });
    const tmpPath = await writeTempConfig(root);
    const { buildPlan } = await import('./plan.js');
    await expectPlanError(
      buildPlan(tmpPath, ctx),
      /Cycle detected.*a.*b|Cycle detected.*b.*a/s,
    );
  });

  it('preview vercelDeployment requires non-empty ctx.gitBranch', async () => {
    const root = stack({
      spec: () => {
        const db = postgres({ spec: () => ({ name: 'main' }) });
        const web = vercelDeployment({
          dependsOn: { db },
          spec: ({ db }) => ({
            project: 'demo',
            // production:false → preview deploy
            env: { DATABASE_URL: db.connectionString },
          }),
        });
        return { db, web };
      },
    });
    const tmpPath = await writeTempConfig(root);
    const { buildPlan } = await import('./plan.js');
    const ctxNoGit: LaunchContext = {
      gitBranch: '',
      flags: {},
      processEnv: {},
    };
    await expectPlanError(
      buildPlan(tmpPath, ctxNoGit),
      /preview deploy.*ctx\.gitBranch is empty/s,
    );
  });

  it('root stack with dependsOn rejected at plan time', async () => {
    const db = postgres({ spec: () => ({ name: 'main' }) });
    const root = stack({ spec: () => ({ db }) });
    // Inject illegal dependsOn on the root.
    (root as unknown as { __dependsOn: Record<string, unknown> }).__dependsOn =
      { db };
    const tmpPath = await writeTempConfig(root);
    const { buildPlan } = await import('./plan.js');
    await expectPlanError(
      buildPlan(tmpPath, ctx),
      /root stack cannot have `dependsOn`/,
    );
  });

  it('stack spec returning a non-object throws stackSpecNotRecord', async () => {
    const root = stack({
      // Returning a string violates the "record of resources" contract.
      spec: () => 'not-a-record' as never,
    });
    const tmpPath = await writeTempConfig(root);
    const { buildPlan } = await import('./plan.js');
    await expectPlanError(
      buildPlan(tmpPath, ctx),
      /did not return a record of resources/,
    );
  });

  it('invariant order — cycle fires before localCommand-readiness when both are violated', async () => {
    // A cyclic graph is a more fundamental error than a missing readiness
    // signal. The header comment in plan.ts documents this order; the test
    // pins it so a future refactor of buildPlan can't silently reorder
    // user-facing errors.
    const a = postgres({ spec: () => ({ name: 'main' }) });
    // `b` has dependents (a, after we inject the back-edge) and no
    // readiness — would normally fire enforceLocalCommandReadiness.
    const b = localCommand({
      dependsOn: { a },
      spec: ({ a }) => ({
        command: 'echo hi',
        env: { X: a.host },
        // No readiness — violates enforceLocalCommandReadiness if reached.
      }),
    });
    // Inject the back-edge a → b to create a cycle.
    (a as unknown as { __dependsOn: Record<string, unknown> }).__dependsOn = {
      b,
    };
    const root = stack({ spec: () => ({ a, b }) });
    const tmpPath = await writeTempConfig(root);
    const { buildPlan } = await import('./plan.js');
    // Cycle wins.
    await expectPlanError(buildPlan(tmpPath, ctx), /Cycle detected/);
  });

  it('localCommand without dependents may omit readiness', async () => {
    const root = stack({
      spec: () => {
        const db = postgres({ spec: () => ({ name: 'main' }) });
        const dev = localCommand({
          dependsOn: { db },
          spec: ({ db }) => ({
            command: 'npm run dev',
            env: { DATABASE_URL: db.connectionString },
            // no readiness — but nothing depends on `dev`, so OK
          }),
        });
        return { db, dev };
      },
    });
    const tmpPath = await writeTempConfig(root);
    const { buildPlan } = await import('./plan.js');
    const plan = await buildPlan(tmpPath, ctx);
    expect(plan.order).toEqual(['db', 'dev']);
  });
});

// =============================================================================
// Helper — write a config file that re-imports the resource graph
// =============================================================================

async function writeTempConfig(root: unknown): Promise<string> {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'neon-launch-plan-test-'));
  const file = path.join(dir, 'neon.ts');
  // jiti will evaluate this file. We stash the resource graph on globalThis
  // and re-export from a TS file so the import is real (matches production).
  const slot = `__plan_test_${Math.random().toString(36).slice(2)}`;
  (globalThis as Record<string, unknown>)[slot] = root;
  writeFileSync(
    file,
    `export default (globalThis as Record<string, unknown>)['${slot}'];\n`,
  );
  return file;
}
