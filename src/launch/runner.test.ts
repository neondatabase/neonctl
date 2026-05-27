/**
 * Runner tests — pin the pure pieces that bear weight on Ctrl-C and
 * concurrent-failure semantics:
 *   - `groupStages` builds correct dependency-ordered batches and rejects
 *     when no progress can be made (cycle was missed upstream).
 *   - `pickStdioMode` picks 'inherit' only for a single, logMatch-free,
 *     leaf node — otherwise 'prefixed'. The 'inherit' decision is
 *     load-bearing for TTY Ctrl-C UX of `next dev`/`vite`; getting it
 *     wrong reintroduces the grandchild-leak P0.
 */
import { describe, it, expect, vi } from 'vitest';

import type { Plan, PlanNode } from './plan.js';

// runner.ts → ../api.ts → ../pkg.ts (reads package.json relative to itself).
// Stub the pkg module so vitest's TS-source run doesn't try to read a file
// that only exists in the built dist/.
vi.mock('../pkg.ts', () => ({ default: { version: '0.0.0' } }));

import { groupStages, pickStdioMode } from './runner.js';

// -----------------------------------------------------------------------------
// PlanNode fixtures
// -----------------------------------------------------------------------------

function node(
  fqn: string,
  kind: 'postgres' | 'local-command' | 'vercel-deployment' | 'stack',
  deps: string[],
  spec: unknown = {},
): PlanNode {
  return {
    name: fqn,
    localKey: fqn,
    resource: {
      __kind: kind,
      __id: fqn,
      __spec: () => spec,
      __dependsOn: {},
    } as any,
    spec,
    parentFqn: null,
    deps,
  };
}

function plan(nodes: PlanNode[]): Plan {
  const registry = new Map<string, PlanNode>(nodes.map((n) => [n.name, n]));
  return {
    registry,
    order: nodes.map((n) => n.name),
    ctx: {} as any,
  };
}

// -----------------------------------------------------------------------------
// groupStages
// -----------------------------------------------------------------------------

describe('groupStages', () => {
  it('independent nodes → single parallel stage', () => {
    const stages = groupStages(
      plan([node('a', 'postgres', []), node('b', 'postgres', [])]),
    );
    expect(stages.length).toBe(1);
    expect(stages[0].map((n) => n.name).sort()).toEqual(['a', 'b']);
  });

  it('linear chain → one node per stage', () => {
    const stages = groupStages(
      plan([
        node('db', 'postgres', []),
        node('migrate', 'local-command', ['db']),
        node('dev', 'local-command', ['db', 'migrate']),
      ]),
    );
    expect(stages.map((s) => s.map((n) => n.name))).toEqual([
      ['db'],
      ['migrate'],
      ['dev'],
    ]);
  });

  it('diamond → stage 0: root; stage 1: both branches; stage 2: sink', () => {
    const stages = groupStages(
      plan([
        node('db', 'postgres', []),
        node('a', 'local-command', ['db']),
        node('b', 'local-command', ['db']),
        node('web', 'vercel-deployment', ['a', 'b']),
      ]),
    );
    expect(stages.length).toBe(3);
    expect(stages[0].map((n) => n.name)).toEqual(['db']);
    expect(stages[1].map((n) => n.name).sort()).toEqual(['a', 'b']);
    expect(stages[2].map((n) => n.name)).toEqual(['web']);
  });

  it('cycle that slipped past the cycle check throws an internal error', () => {
    // Construct a real 2-node cycle (a → b → a). plan.ts rejects this at
    // build time, but groupStages is the second line of defense — if a
    // future refactor bypasses the cycle check, the runner must still
    // refuse to silently spin.
    expect(() =>
      groupStages(
        plan([node('a', 'postgres', ['b']), node('b', 'local-command', ['a'])]),
      ),
    ).toThrowError(/stage grouping made no progress/);
  });
});

// -----------------------------------------------------------------------------
// pickStdioMode — the decision is load-bearing for TTY Ctrl-C UX.
// -----------------------------------------------------------------------------

describe('pickStdioMode', () => {
  const cmdNoReadiness = node('dev', 'local-command', [], {
    command: 'next dev',
    readiness: { httpGet: { url: 'http://localhost:3000' } },
  });
  const cmdLogMatch = node('dev', 'local-command', [], {
    command: 'next dev',
    readiness: { logMatch: /ready/ },
  });

  it("single leaf node without dependents and without logMatch → 'inherit'", () => {
    expect(pickStdioMode(cmdNoReadiness, 1, false)).toBe('inherit');
  });

  it("logMatch readiness forces 'prefixed' (needs captured stdout)", () => {
    expect(pickStdioMode(cmdLogMatch, 1, false)).toBe('prefixed');
  });

  it("having dependents forces 'prefixed' (kill cascade must reach grandchildren)", () => {
    expect(pickStdioMode(cmdNoReadiness, 1, true)).toBe('prefixed');
  });

  it("more than one local-command in the stage forces 'prefixed' (no TTY interleave)", () => {
    expect(pickStdioMode(cmdNoReadiness, 2, false)).toBe('prefixed');
  });
});
