/**
 * Plan-time invariant tests — every error template in §5 must fire from a
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
