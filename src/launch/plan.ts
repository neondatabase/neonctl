/**
 * Plan phase — load `neon.ts`, walk the resource tree, build the registry
 * and dep graph, run plan-time invariants.
 *
 * Plan-time invariants run in this order; first failure stops the launch:
 *   1. Dup-key (same resource value at two record keys)
 *   2. Singleton postgres (exactly one in the tree)
 *   3. Deps-in-tree (every dependsOn value is in the registry)
 *   4. No cycles
 *
 * The dep-edge match is by per-instance __id first (UUID assigned at
 * factory time; survives jiti double-module load), then === identity
 * (hedge against UUID failure). Never structural equality.
 */
import { resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import { createJiti } from 'jiti';

import type {
  DepsRecord,
  InternalResource,
  LaunchContext,
  Resource,
} from './config.js';
import {
  ExitCode,
  LaunchError,
  dupKeyMessage,
  singletonMessage,
} from './errors.js';
import { makeRef } from './refs.js';

// =============================================================================
// Types
// =============================================================================

/**
 * A node in the resolved tree. Each child resource gets a fully-qualified
 * name (dotted path from the root: `db`, `web`, `data.primary`).
 */
export type PlanNode = {
  /** Fully qualified name; dotted path from the root stack. */
  name: string;
  /** Local key in the parent stack's returned record. */
  localKey: string;
  /** The resource itself (carries __kind, __id, __spec, __dependsOn). */
  resource: InternalResource;
  /** Resolved spec object — produced by calling resource.__spec(deps, ctx). */
  spec: unknown;
  /** Parent stack's FQN, or null if this node is a direct child of the root. */
  parentFqn: string | null;
  /** FQNs of resources this node depends on (matches registry keys). */
  deps: string[];
};

export type Plan = {
  /** Map of FQN → node. Iteration order matches plan-walk order. */
  registry: Map<string, PlanNode>;
  /** Topologically sorted FQNs (deps before dependents). */
  order: string[];
  /** The launch context, frozen for the rest of the run. */
  ctx: LaunchContext;
};

// =============================================================================
// Internals
// =============================================================================

function isInternalResource(v: unknown): v is InternalResource {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as InternalResource).__kind === 'string' &&
    typeof (v as InternalResource).__id === 'string' &&
    typeof (v as InternalResource).__spec === 'function'
  );
}

function joinFqn(parent: string | null, key: string): string {
  return parent === null ? key : `${parent}.${key}`;
}

/**
 * Walk a resource tree starting from `root`. Returns the registry.
 *
 * For each stack node: invoke spec(deps, ctx) → expect a record of
 * Resources → recurse on each child. For each leaf: invoke spec(deps, ctx)
 * → record the spec object on the PlanNode.
 *
 * Deps to a non-root stack are passed as `deps` — at plan time these are
 * the Ref-bearing proxies (the launcher resolves them just before the
 * dependent provisioner runs). The proxies satisfy the spec's type-level
 * `Resolved<D>` contract; runtime resolution lives in `src/launch/refs.ts`.
 */
function walkTree(
  root: InternalResource,
  ctx: LaunchContext,
): Map<string, PlanNode> {
  const registry = new Map<string, PlanNode>();

  type Frame = {
    resource: InternalResource;
    localKey: string;
    parentFqn: string | null;
    /** Deps record to pass into this node's spec callback. */
    depsArg: Record<string, unknown>;
  };

  // The root stack has localKey ''; we synthesize an FQN of 'root' for
  // logs but exclude it from the registry (its children are what we
  // provision).
  const queue: Frame[] = [
    {
      resource: root,
      localKey: '',
      parentFqn: null,
      depsArg: {},
    },
  ];

  while (queue.length > 0) {
    const frame = queue.shift();
    if (!frame) break;
    const fqn =
      frame.localKey === '' ? '' : joinFqn(frame.parentFqn, frame.localKey);

    // Invoke the spec callback. The root stack gets `deps = {}`; each
    // child leaf gets a record of Ref-bearing proxies (see makeOutputProxy
    // below) the runner swaps for real values before that leaf runs.
    const spec = frame.resource.__spec(frame.depsArg as never, ctx);

    // Stacks return a record; leaves return a spec object.
    if (frame.resource.__kind === 'stack') {
      if (typeof spec !== 'object' || spec === null) {
        throw new LaunchError(
          `[neon launch] Stack '${fqn || 'root'}' spec did not return a record of resources (got ${typeof spec}).`,
          ExitCode.CONFIG_ERROR,
        );
      }
      // Track per-stack dup-key check via reference identity.
      const seenValues = new Map<unknown, string>();
      for (const [key, value] of Object.entries(
        spec as Record<string, unknown>,
      )) {
        if (!isInternalResource(value)) {
          throw new LaunchError(
            `[neon launch] Stack '${fqn || 'root'}' returned key '${key}' that is not a resource. ` +
              `Every value in a stack's returned record must be the result of a factory call.`,
            ExitCode.CONFIG_ERROR,
          );
        }
        // Nested stacks aren't supported in v1 — the registry only holds
        // leaves, and the runner has no resolver for stack outputs. Throw
        // early with a clear pointer instead of letting the deps-in-tree
        // check fire later with a misleading "did you forget to include
        // it?" message.
        if (value.__kind === 'stack') {
          throw new LaunchError(
            [
              `[neon launch] Nested stacks are not supported in v1.`,
              `Stack '${fqn || 'root'}' returns a nested stack at key '${key}'.`,
              '',
              `Inline the nested stack's children into the parent's returned record:`,
              `  return { db, web, ...nested.spec() };  // hand-roll for now`,
              '',
              `Or factor the children into a plain function that returns the same record:`,
              `  const buildData = () => ({ primary: postgres({...}) });`,
              `  return { ...buildData(), web };`,
            ].join('\n'),
            ExitCode.CONFIG_ERROR,
          );
        }
        // Dup-key invariant — checked HERE per stack so the error template
        // names the offending stack rather than after the full walk.
        const prior = seenValues.get(value);
        if (prior !== undefined) {
          throw new LaunchError(
            dupKeyMessage({
              stackName: fqn || 'root',
              keyA: prior,
              keyB: key,
              kind: value.__kind,
            }),
            ExitCode.CONFIG_ERROR,
          );
        }
        seenValues.set(value, key);

        // Build the deps argument for this child's spec callback.
        const childDepsArg: Record<string, unknown> = {};
        for (const [depKey, depRes] of Object.entries(value.__dependsOn)) {
          // At plan time we pass a Ref-bearing proxy for the dep's outputs
          // (matches the SpecFn type). The provisioner replaces these with
          // real values at runtime. The proxy is intentionally minimal:
          // property access yields a Ref<string> keyed on the dep's FQN.
          childDepsArg[depKey] = makeOutputProxy(depRes as InternalResource);
        }

        queue.push({
          resource: value,
          localKey: key,
          parentFqn: fqn === '' ? null : fqn,
          depsArg: childDepsArg,
        });
      }
    } else {
      // Leaf: register it.
      registry.set(fqn, {
        name: fqn,
        localKey: frame.localKey,
        resource: frame.resource,
        spec,
        parentFqn: frame.parentFqn,
        deps: Object.values(frame.resource.__dependsOn).map((d) =>
          findResourceFqn(d as InternalResource, registry),
        ),
      });
    }
  }

  return registry;
}

/**
 * Resolve a dep's FQN by looking up its `__id` (primary) or `===` identity
 * (fallback) in the registry. Returns `''` if not found — the deps-in-tree
 * invariant catches that case afterwards.
 *
 * Note: at the moment a leaf is registered, the registry may not yet
 * contain its deps (they could be later in the queue). We populate
 * `deps[]` lazily in a second pass after the walk; this function is the
 * lazy-resolver.
 */
function findResourceFqn(
  target: InternalResource,
  registry: Map<string, PlanNode>,
): string {
  for (const [fqn, node] of registry) {
    if (node.resource.__id === target.__id) return fqn;
    if (node.resource === target) return fqn;
  }
  return '';
}

/**
 * Build a minimal proxy for a dep's outputs at plan time. Property access
 * yields a `Ref<string>` keyed on `<dep.__id>.<prop>`. The runner's
 * `resolveLeaf` looks the id up in its `outputs` map at provision time
 * and swaps the ref for the real value before passing env to the
 * dependent.
 */
function makeOutputProxy(dep: InternalResource): unknown {
  // Spec callbacks read outputs (`db.connectionString`, `web.url`) at the
  // moment the parent's `spec(deps, ctx)` runs — which is plan time. The
  // returned ref encodes which resource + which property; the runner does
  // the actual lookup.
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined;
        // Skip the well-known protocol hooks JS engines probe ('then', etc).
        // Returning a ref for `then` would make the proxy look thenable and
        // break Promise.resolve(proxy).
        if (prop === 'then' || prop === 'toJSON') return undefined;
        return makeRef(`${dep.__id}.${prop}`);
      },
    },
  );
}

// =============================================================================
// Plan-time invariants
// =============================================================================

function enforceSingletonPostgres(registry: Map<string, PlanNode>): void {
  const postgresNodes: PlanNode[] = [];
  for (const node of registry.values()) {
    if (node.resource.__kind === 'postgres') postgresNodes.push(node);
  }
  if (postgresNodes.length !== 1) {
    throw new LaunchError(
      singletonMessage({
        count: postgresNodes.length,
        names: postgresNodes.map((n) => n.name),
      }),
      ExitCode.CONFIG_ERROR,
    );
  }
}

function enforceDepsInTree(registry: Map<string, PlanNode>): void {
  for (const node of registry.values()) {
    for (const [depKey, depRes] of Object.entries(node.resource.__dependsOn)) {
      const found = findResourceFqn(depRes as InternalResource, registry);
      if (found === '') {
        throw new LaunchError(
          `[neon launch] Resource '${node.name}' depends on '${depKey}', ` +
            `but that resource is not in the resolved tree. ` +
            `Did you declare it but forget to include it in some stack's return record?`,
          ExitCode.CONFIG_ERROR,
        );
      }
    }
  }
}

function topoOrder(registry: Map<string, PlanNode>): string[] {
  // Standard Kahn's algorithm. Edges: node → its dependents.
  const inDegree = new Map<string, number>();
  const edges = new Map<string, string[]>();

  for (const fqn of registry.keys()) {
    inDegree.set(fqn, 0);
    edges.set(fqn, []);
  }

  for (const node of registry.values()) {
    for (const dep of node.deps) {
      if (dep === '') continue;
      const depEdges = edges.get(dep);
      if (depEdges) depEdges.push(node.name);
      inDegree.set(node.name, (inDegree.get(node.name) ?? 0) + 1);
    }
  }

  const ready: string[] = [];
  for (const [fqn, deg] of inDegree) {
    if (deg === 0) ready.push(fqn);
  }

  const order: string[] = [];
  while (ready.length > 0) {
    const next = ready.shift();
    if (next === undefined) break;
    order.push(next);
    for (const dependent of edges.get(next) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) ready.push(dependent);
    }
  }

  if (order.length !== registry.size) {
    // Find the cycle for a helpful error.
    const remaining = [...inDegree.entries()]
      .filter(([, d]) => d > 0)
      .map(([k]) => k);
    throw new LaunchError(
      `[neon launch] Cycle detected in resource dependencies. ` +
        `Involved resources: ${remaining.join(', ')}.`,
      ExitCode.CONFIG_ERROR,
    );
  }

  return order;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Load `neon.ts`, validate it default-exports a stack, walk the tree, run
 * invariants, return the Plan.
 *
 * @param configPath Absolute or cwd-relative path to neon.ts.
 * @param ctx Launch context — passed to every spec callback.
 */
export async function buildPlan(
  configPath: string,
  ctx: LaunchContext,
): Promise<Plan> {
  const absPath = resolvePath(process.cwd(), configPath);
  if (!existsSync(absPath)) {
    throw new LaunchError(
      [
        `[neon launch] Config file not found: ${absPath}`,
        '',
        `Create a \`neon.ts\` at the repo root. Minimal starter:`,
        '',
        `  import { stack, postgres } from 'neonctl/config';`,
        '',
        `  export default stack({`,
        `    spec: (_, { gitBranch }) => {`,
        `      const db = postgres({`,
        `        spec: () => ({ name: gitBranch || 'main' }),`,
        `      });`,
        `      return { db };`,
        `    },`,
        `  });`,
        '',
        `Then run \`neon launch\` again. See the full announcement in the repo.`,
      ].join('\n'),
      ExitCode.CONFIG_ERROR,
    );
  }

  const jiti = createJiti(import.meta.url);
  const loaded = await jiti.import(absPath);
  const mod = loaded as { default?: unknown };
  const def = mod.default;
  if (!isInternalResource(def) || def.__kind !== 'stack') {
    const found =
      typeof def === 'object' && def !== null
        ? ((def as { __kind?: string }).__kind ?? 'a plain object')
        : typeof def;
    throw new LaunchError(
      `[neon launch] ${configPath} must default-export a stack({...}) from 'neonctl/config'. Found: ${found}.`,
      ExitCode.CONFIG_ERROR,
    );
  }

  // Walk the tree. Dup-key check fires during the walk.
  const registry = walkTree(def, ctx);

  // Now resolve dep FQNs lazily — the walker recorded them eagerly but
  // dep targets may have been registered later in the BFS. Re-resolve.
  for (const node of registry.values()) {
    node.deps = Object.values(node.resource.__dependsOn).map((d) =>
      findResourceFqn(d as InternalResource, registry),
    );
  }

  // Plan-time invariants — singleton postgres + deps-in-tree + no cycles.
  // Dup-key already enforced in the walk.
  enforceSingletonPostgres(registry);
  enforceDepsInTree(registry);
  const order = topoOrder(registry);

  return { registry, order, ctx };
}

// Re-export for testing.
export { isInternalResource };

// Re-export DepsRecord for callers that don't want to deep-import.
export type { DepsRecord, Resource };
