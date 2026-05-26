/**
 * Public surface of `neonctl/config`.
 *
 * The `stack({ spec })` exported here is what users default-export from their
 * `neon.ts`; the four `postgres / vercelDeployment / localCommand / stack`
 * factories build the resource tree the launcher provisions.
 *
 * Spec §2.3 is the authoritative type contract. This file IS the contract;
 * if you change a type here, update the spec first.
 *
 * Design invariants — DO NOT REVERSE these in review (every one was
 * rejected at design time after multiple rounds of review):
 *   #1  No CLI-side mode detection. Policy lives in the user's stack spec.
 *   #2  No `defineConfig` helper alongside `stack`. `stack({...})` IS the
 *       typing helper.
 *   #3  No top-level `postgres:` slot in NeonConfig. Postgres is a resource
 *       declared inside the stack like any other (kills the noun-collision).
 *   #4  No `type:` string discriminator on resources. Factory functions
 *       give narrow per-kind intellisense.
 *   #5  No `name` positional arg on factories. Names come from the parent
 *       record key — single source of truth.
 *   #6  No string-array `dependsOn`. It's a value-record `dependsOn: { db }`
 *       — TypeScript narrows via value identity.
 *   #7  No polymorphic specs (object OR function). Every spec is
 *       `(deps, ctx) => SpecObject`. Uniform shape, one mental model.
 *
 * Spec §11 pitfalls #1–#7. Spec §1 non-goals.
 */
import type { Ref } from './refs.js';

// =============================================================================
// Context + flags
// =============================================================================

/**
 * CLI flag values that fall through to `ctx.flags`. Yargs' default coercion
 * gives us booleans for bare `--preview`, strings for `--key=value`, arrays
 * for repeated keys, numbers for numeric strings. See impl-plan Phase 3.1
 * for the extraction rule.
 */
export type FlagValue = string | string[] | number | boolean;

/**
 * Second argument every `spec` function receives. The launcher resolves
 * `gitBranch` once (precedence chain in spec §3.2 step 2 / impl-plan Phase 3.4)
 * and propagates the same value into every spec callback in the tree.
 */
export type LaunchContext = {
  gitBranch: string;
  flags: Record<string, FlagValue>;
  processEnv: NodeJS.ProcessEnv;
};

// =============================================================================
// Resource + dep-graph machinery
// =============================================================================

/**
 * Every factory returns a Resource. `Kind` is the runtime discriminator the
 * launcher switches on (spec §11 #19 — dispatch by string, never instanceof).
 * `Outputs` is a phantom type used only for `dependsOn` narrowing — it isn't
 * populated at construction time.
 */
export type Resource<Kind extends string = string, Outputs = unknown> = {
  readonly __kind: Kind;
  readonly __outputs: Outputs;
};

/**
 * `dependsOn` is a record of Resource values (spec §11 #6). String arrays
 * forced self-referential TS types or runtime-only validation — value records
 * give full narrowing for free.
 */
export type DepsRecord = Record<string, Resource>;

/**
 * Map a dep record onto each dep's resolved outputs — the shape the spec
 * callback sees as its first argument. This is the heart of the value-identity
 * narrowing: TypeScript infers `D` from the user's literal record, then
 * `Resolved<D>` peels off the outputs.
 */
export type Resolved<D extends DepsRecord> = {
  [K in keyof D]: D[K]['__outputs'];
};

/**
 * Spec function signature — uniform across every resource kind (spec §11 #7).
 * Trailing unused args may be omitted: `() => ({...})` and `(_, { gitBranch }) =>`
 * are both valid shorthands.
 */
export type SpecFn<D extends DepsRecord, SpecObj> = (
  deps: Resolved<D>,
  ctx: LaunchContext,
) => SpecObj;

// =============================================================================
// Postgres
// =============================================================================

export type ComputeSpec = {
  minCu?: number;
  maxCu?: number;
  /**
   * `0` (or omitted) → project default; `-1` → never suspend; positive →
   * literal seconds. See spec §2.2.3 and impl-plan Phase 5.1 step 7 for
   * how the launcher reconciles drift against project defaults.
   */
  suspendTimeoutSeconds?: number;
};

export type PostgresSpec = {
  name: string;
  /**
   * Parent branch name to fork from when `name` doesn't exist. Omitted →
   * the project's default branch (resolved via `listProjectBranches` looking
   * for `default: true`). Spec §2.2.2.
   */
  branchFrom?: string;
  compute?: ComputeSpec;
};

/**
 * `connectionString` is both a Ref<string> (no-args property access) AND
 * callable with opts (`db.connectionString({ pooled: false })`). Each call
 * produces a new Ref tagged with the opts; the launcher re-issues
 * `GET /projects/{id}/connection_uri` per opts-tuple (spec §2.4, §3.2 step 5).
 */
export type ConnectionStringCallable = (opts?: {
  pooled?: boolean;
  role?: string;
  database?: string;
}) => Ref<string>;

export type PostgresOutputs = {
  connectionString: Ref<string> & ConnectionStringCallable;
  host: Ref<string>;
  database: Ref<string>;
  role: Ref<string>;
};

// =============================================================================
// Vercel deployment
// =============================================================================

export type VercelDeploymentSpec = {
  /** Vercel project name or projectId. */
  project: string;
  /** Team id (`team_xxx`). Persisted in `.neon-launch.env` once resolved. */
  teamId?: string;
  /**
   * Team slug. Resolved to `teamId` via `GET /v2/teams/{slug}` once; persist
   * the resolved id (spec §3.3 last paragraph).
   */
  team?: string;
  /**
   * `true` → production deploy + `target: ['production']` env vars (no
   * `gitBranch` scoping). `false`/omitted → preview deploy + `target: ['preview']`
   * env vars scoped to `ctx.gitBranch` (spec §11 #31, #33).
   */
  production?: boolean;
  /**
   * Env vars to upsert. `Ref<string>` values resolve at provision time;
   * plain strings pass through. Spec §2.3 + §3.2 step 5.
   */
  env: Record<string, string | Ref<string>>;
};

export type VercelDeploymentOutputs = {
  url: Ref<string>;
};

// =============================================================================
// Local command
// =============================================================================

/**
 * Readiness signals — required when this command has dependents (spec §11 #8).
 * One-shot commands (`onExit`) and long-running commands with no dependents
 * may omit it.
 */
export type LocalCommandReadiness =
  | { onExit: number }
  | { portListening: number; host?: string }
  | {
      httpGet: {
        url: string;
        /** Expected response status. Default 200. */
        status?: number;
        /** Per-attempt request timeout in ms. Default 2000. */
        timeoutMs?: number;
      };
    }
  | { logMatch: RegExp };

export type LocalCommandSpec = {
  command: string;
  /** Working directory; defaults to repo root. */
  cwd?: string;
  env?: Record<string, string | Ref<string>>;
  readiness?: LocalCommandReadiness;
};

export type LocalCommandOutputs = {
  /** Populated for `onExit`-readiness one-shots once they exit. */
  exitCode?: number;
};

// =============================================================================
// Internal resource representation
// =============================================================================

/**
 * What the launcher actually sees on a resource. The four public output-type
 * narrowing properties (`__kind`, `__outputs`) plus three runtime carriers
 * (`__id`, `__dependsOn`, `__spec`).
 *
 * Per-instance `__id` (UUID) is the primary dep-edge match key — it survives
 * the "two copies of the factory code in play" failure mode (spec §11 #19 +
 * impl-plan Phase 2.5) better than `===` identity alone.
 */
export type InternalResource<
  Kind extends string = string,
  Outputs = unknown,
> = Resource<Kind, Outputs> & {
  readonly __id: string;
  readonly __dependsOn: DepsRecord;
  readonly __spec: SpecFn<DepsRecord, unknown>;
};

// Monotonic UUID-ish generator — collision-resistant enough for in-process
// dep matching. Not cryptographic.
let __idCounter = 0;
function nextResourceId(kind: string): string {
  __idCounter += 1;
  return `${kind}:${__idCounter.toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

function buildResource<Kind extends string, Outputs, D extends DepsRecord>(
  kind: Kind,
  opts: { dependsOn?: D; spec: SpecFn<D, unknown> },
): Resource<Kind, Outputs> {
  const internal: InternalResource<Kind, Outputs> = {
    __kind: kind,
    // `__outputs` is phantom — narrowing-only. Never read at runtime.
    __outputs: undefined as Outputs,
    __id: nextResourceId(kind),
    __dependsOn: (opts.dependsOn ?? {}) as DepsRecord,
    __spec: opts.spec as SpecFn<DepsRecord, unknown>,
  };
  return internal;
}

// =============================================================================
// Factory functions
// =============================================================================

/**
 * Declares a Neon Postgres branch. Exactly one `postgres(...)` per launch
 * tree (plan-time invariant — spec §3.2 step 4 + §5.2).
 *
 * @example
 * ```ts
 * const db = postgres({
 *   spec: (_, { gitBranch }) => ({
 *     name: gitBranch,
 *     // branchFrom omitted → fork from the project's default branch
 *     compute: { minCu: 0.25, maxCu: 1 },
 *   }),
 * });
 * ```
 */
export function postgres<D extends DepsRecord = Record<string, never>>(opts: {
  dependsOn?: D;
  spec: SpecFn<D, PostgresSpec>;
}): Resource<'postgres', PostgresOutputs> {
  return buildResource<'postgres', PostgresOutputs, D>('postgres', opts);
}

/**
 * Declares a Vercel deployment (preview or production based on
 * `spec.production`). Lazy-loads `@vercel/client` at provision time.
 *
 * @example
 * ```ts
 * const web = vercelDeployment({
 *   dependsOn: { db },
 *   spec: ({ db }) => ({
 *     project: 'my-app',
 *     env: { DATABASE_URL: db.connectionString },
 *   }),
 * });
 * ```
 */
export function vercelDeployment<
  D extends DepsRecord = Record<string, never>,
>(opts: {
  dependsOn?: D;
  spec: SpecFn<D, VercelDeploymentSpec>;
}): Resource<'vercel-deployment', VercelDeploymentOutputs> {
  return buildResource<'vercel-deployment', VercelDeploymentOutputs, D>(
    'vercel-deployment',
    opts,
  );
}

/**
 * Spawns a local command — dev server, migration, seed, anything. Required
 * `readiness` if dependents exist (spec §11 #8).
 *
 * @example
 * ```ts
 * const dev = localCommand({
 *   dependsOn: { db },
 *   spec: ({ db }) => ({
 *     command: 'npm run dev',
 *     env: { DATABASE_URL: db.connectionString },
 *     readiness: { httpGet: { url: 'http://localhost:3000' } },
 *   }),
 * });
 * ```
 */
export function localCommand<
  D extends DepsRecord = Record<string, never>,
>(opts: {
  dependsOn?: D;
  spec: SpecFn<D, LocalCommandSpec>;
}): Resource<'local-command', LocalCommandOutputs> {
  return buildResource<'local-command', LocalCommandOutputs, D>(
    'local-command',
    opts,
  );
}

/**
 * A stack groups child resources into a record. The top-level export of
 * `neon.ts` is a `stack({ spec })`; stacks can also be nested as deps of
 * other resources to compose larger graphs (spec §2.2 Pattern E).
 *
 * Stack outputs = the record of its children's outputs. TypeScript picks
 * this up automatically from the spec's return type.
 *
 * @example
 * ```ts
 * export default stack({
 *   spec: (_, { gitBranch, flags }) => {
 *     const db = postgres({ spec: () => ({ name: gitBranch }) });
 *     if (flags.preview) {
 *       return { db, web: vercelDeployment({ dependsOn: { db }, spec: ... }) };
 *     }
 *     return { db, dev: localCommand({ dependsOn: { db }, spec: ... }) };
 *   },
 * });
 * ```
 */
export function stack<
  D extends DepsRecord = Record<string, never>,
  Children extends Record<string, Resource> = Record<string, never>,
>(opts: {
  dependsOn?: D;
  spec: SpecFn<D, Children>;
}): Resource<'stack', { [K in keyof Children]: Children[K]['__outputs'] }> {
  return buildResource<
    'stack',
    { [K in keyof Children]: Children[K]['__outputs'] },
    D
  >('stack', opts);
}

// =============================================================================
// Re-exports from refs.ts so consumers see them via `neonctl/config`
// =============================================================================

export { makeRef, type Ref } from './refs.js';
