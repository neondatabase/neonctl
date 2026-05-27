/**
 * Plan-time invariant tests — every error template must fire from a
 * realistic config shape. Catches the most common ways users break the
 * stack/record/dep contract.
 */
import { describe, it, expect } from 'vitest';

import { postgres, localCommand, stack, vercelDeployment } from './config.js';
import { isInternalResource } from './plan.js';
import type { LaunchContext } from './config.js';

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
    await expect(buildPlan(tmpPath, ctx)).rejects.toThrow(
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
    await expect(buildPlan(tmpPath, ctx)).rejects.toThrow(
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
    await expect(buildPlan(tmpPath, ctx)).rejects.toThrow(
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
    await expect(buildPlan(tmpPath, ctx)).rejects.toThrow(
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
    await expect(buildPlan(tmpPath, ctx)).rejects.toThrow(
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
    await expect(buildPlan(tmpPath, ctx)).rejects.toThrow(
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
    await expect(buildPlan(tmpPath, ctx)).rejects.toThrow(
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
    await expect(buildPlan(tmpPath, ctx)).rejects.toThrow(
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
    await expect(buildPlan(tmpPath, ctxNoGit)).rejects.toThrow(
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
    await expect(buildPlan(tmpPath, ctx)).rejects.toThrow(
      /root stack cannot have `dependsOn`/,
    );
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
