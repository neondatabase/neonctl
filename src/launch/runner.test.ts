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

import {
  getCliProjectIdFromArgv,
  groupStages,
  pickStdioMode,
} from './runner.js';

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

  // Each test explicitly passes `isTty` so the result doesn't depend on
  // the environment vitest runs in (CI runs without a TTY; locally
  // typically with one). The non-TTY case is covered separately below.

  it("single leaf node alone in its stage with TTY → 'inherit'", () => {
    expect(pickStdioMode(cmdNoReadiness, 1, false, 1, true)).toBe('inherit');
  });

  it("logMatch readiness forces 'prefixed' (needs captured stdout)", () => {
    expect(pickStdioMode(cmdLogMatch, 1, false, 1, true)).toBe('prefixed');
  });

  it("having dependents forces 'prefixed' (kill cascade must reach grandchildren)", () => {
    expect(pickStdioMode(cmdNoReadiness, 1, true, 1, true)).toBe('prefixed');
  });

  it("more than one local-command in the stage forces 'prefixed' (no TTY interleave)", () => {
    // Isolate the localCmdCount check by keeping stageSize === 1 so the
    // sibling-count rule doesn't fire first. (Realistic in production
    // these would match, but the test should pin one condition at a time.)
    expect(pickStdioMode(cmdNoReadiness, 2, false, 1, true)).toBe('prefixed');
  });

  it("any sibling in the same stage forces 'prefixed' (sibling failure → kill cascade)", () => {
    // Stage has [vercelDeployment, localCommand]. The localCommand has no
    // dependents and is the only local-command, but if the Vercel sibling
    // 4xx's the fast-cancel will kill this node. In inherit mode that
    // signals only the wrapping shell — the dev-server grandchild
    // survives and holds its port.
    expect(pickStdioMode(cmdNoReadiness, 1, false, 2, true)).toBe('prefixed');
  });

  it("non-TTY parent (supervisor / pipe) forces 'prefixed' regardless of other checks", () => {
    // Otherwise inherit-mode + non-detached means SIGTERM from
    // docker/k8s/systemd only reaches the wrapping shell, leaving the
    // dev-server grandchild as an orphan holding the port.
    expect(pickStdioMode(cmdNoReadiness, 1, false, 1, false)).toBe('prefixed');
  });
});

// -----------------------------------------------------------------------------
// getCliProjectIdFromArgv — load-bearing for the CLI > env > middleware
// precedence chain. The middleware path (silent neon-context write) makes
// this scanner the only way to tell "user explicitly passed --project-id"
// from "middleware filled it in". A regression here can destructively
// provision against the wrong project.
// -----------------------------------------------------------------------------

describe('getCliProjectIdFromArgv', () => {
  it('returns undefined when no flag is present', () => {
    expect(
      getCliProjectIdFromArgv(['node', 'cli.js', 'launch']),
    ).toBeUndefined();
  });

  it('parses space-separated --project-id', () => {
    expect(
      getCliProjectIdFromArgv(['cli', 'launch', '--project-id', 'prj_abc']),
    ).toBe('prj_abc');
  });

  it('parses space-separated --projectId (camelCase)', () => {
    expect(
      getCliProjectIdFromArgv(['cli', 'launch', '--projectId', 'prj_abc']),
    ).toBe('prj_abc');
  });

  it('parses --project-id=value form', () => {
    expect(
      getCliProjectIdFromArgv(['cli', 'launch', '--project-id=prj_abc']),
    ).toBe('prj_abc');
  });

  it('parses --projectId=value form (camelCase)', () => {
    expect(
      getCliProjectIdFromArgv(['cli', 'launch', '--projectId=prj_abc']),
    ).toBe('prj_abc');
  });

  it('empty space-separated value → undefined (env fallback can take over)', () => {
    expect(
      getCliProjectIdFromArgv(['cli', 'launch', '--project-id', '']),
    ).toBeUndefined();
  });

  it('empty --project-id= value → undefined', () => {
    expect(
      getCliProjectIdFromArgv(['cli', 'launch', '--project-id=']),
    ).toBeUndefined();
  });

  it('next-arg starting with -- is NOT consumed as the value', () => {
    // Without this guard, `neon launch --project-id --analytics` would
    // silently use `'--analytics'` as the project id and the downstream
    // API call would 4xx with a confusing message.
    expect(
      getCliProjectIdFromArgv(['cli', 'launch', '--project-id', '--analytics']),
    ).toBeUndefined();
  });

  it('end-of-args yields undefined (no next value)', () => {
    expect(
      getCliProjectIdFromArgv(['cli', 'launch', '--project-id']),
    ).toBeUndefined();
  });

  it('`--` end-of-options separator stops the scan (pass-through args ignored)', () => {
    // yargs is configured with populate--: true. Without the stop, the
    // scanner would silently treat `neon launch -- --project-id=X` as an
    // explicit CLI flag, overriding env vars even though the user
    // intended X to flow through to a downstream tool.
    expect(
      getCliProjectIdFromArgv([
        'cli',
        'launch',
        '--',
        '--project-id=prj_passthrough',
      ]),
    ).toBeUndefined();
  });
});
