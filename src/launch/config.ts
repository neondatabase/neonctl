/**
 * Public surface of `neonctl/config`.
 *
 * The `stack({ spec })` exported here is what users default-export from
 * their `neon.ts`; the four `postgres / vercelDeployment / localCommand /
 * stack` factories build the resource tree the launcher provisions.
 *
 * Design invariants that shape the API:
 *   - Policy lives in the user's stack spec. The CLI does no mode
 *     detection of its own.
 *   - `stack({...})` IS the typing helper; no separate `defineConfig`.
 *   - Postgres is a resource declared inside the stack like any other —
 *     no top-level `postgres:` slot.
 *   - Resources are factory functions, not objects with a `type:`
 *     discriminator. Each factory carries its own narrow intellisense.
 *   - Resource names come from the parent stack's record key — no
 *     positional `name` arg on factories.
 *   - `dependsOn: { db }` is a value record, not a string array.
 *     TypeScript narrows the spec callback's first argument via value
 *     identity.
 *   - Every spec is `(deps, ctx) => SpecObject`. One shape across all
 *     four resource kinds.
 */
import type { Ref } from './refs.js';

// =============================================================================
// Context + flags
// =============================================================================

/**
 * CLI flag values that fall through to `ctx.flags`.
 *
 * The parser hands the launcher booleans for bare `--preview`, strings
 * for `--key=value`, arrays for repeated keys, and numbers for numeric
 * strings. The launcher additionally normalizes the literal strings
 * `'true'` and `'false'` to booleans, so `--prod` (bare) and
 * `--prod=true` are indistinguishable on `ctx.flags`.
 */
export type FlagValue = string | string[] | number | boolean;

/**
 * Second argument every `spec` function receives. The launcher resolves
 * `gitBranch` once and propagates the same value into every spec callback
 * in the tree.
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
 * launcher switches on (dispatch by string, never instanceof). `Outputs` is
 * a phantom type used only for `dependsOn` narrowing — it isn't populated
 * at construction time.
 */
export type Resource<Kind extends string = string, Outputs = unknown> = {
  readonly __kind: Kind;
  readonly __outputs: Outputs;
};

/**
 * `dependsOn` is a record of Resource values. String arrays forced
 * self-referential TS types or runtime-only validation — value records
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
 * Spec function signature — uniform across every resource kind.
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
   * literal seconds. The launcher reconciles drift against project defaults.
   */
  suspendTimeoutSeconds?: number;
};

export type PostgresSpec = {
  name: string;
  /**
   * Parent branch name to fork from when `name` doesn't exist. Omitted →
   * the project's default branch (resolved via `listProjectBranches` looking
   * for `default: true`).
   */
  branchFrom?: string;
  compute?: ComputeSpec;
};

/**
 * `connectionString` is both a Ref<string> (no-args property access) AND
 * callable with opts (`db.connectionString({ pooled: false })`). Each call
 * produces a new Ref tagged with the opts; the launcher re-issues
 * `GET /projects/{id}/connection_uri` per opts-tuple.
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
   * the resolved id.
   */
  team?: string;
  /**
   * `true` → production deploy + `target: ['production']` env vars (no
   * `gitBranch` scoping). `false`/omitted → preview deploy + `target: ['preview']`
   * env vars scoped to `ctx.gitBranch`.
   */
  production?: boolean;
  /**
   * Env vars to upsert. `Ref<string>` values resolve at provision time;
   * plain strings pass through.
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
 * Readiness signals — required when this command has dependents.
 * One-shot commands (`onExit`) and long-running commands with no dependents
 * may omit it.
 */
export type LocalCommandReadiness =
  | {
      /** Expected exit code; readiness fires when the child exits with this code. */
      onExit: number;
    }
  | {
      /** TCP port to probe on localhost; readiness fires when the port accepts a connection. */
      portListening: number;
      /** Host to probe. Defaults to localhost (probes both 127.0.0.1 and ::1). */
      host?: string;
    }
  | {
      httpGet: {
        url: string;
        /** Expected response status. Default 200. */
        status?: number;
        /** Per-attempt request timeout in ms. Default 2000. */
        timeoutMs?: number;
      };
    }
  | {
      /** Regex matched against each line of the child's stdout/stderr. */
      logMatch: RegExp;
    };

export type LocalCommandSpec = {
  command: string;
  /** Working directory; defaults to repo root. */
  cwd?: string;
  env?: Record<string, string | Ref<string>>;
  readiness?: LocalCommandReadiness;
};

/**
 * Local commands don't expose outputs in v1. Use `readiness: { onExit: 0 }`
 * to gate dependents — the command's exit code itself is not available
 * as a Ref. The type is an empty object (vs. `never`, which `stack` uses)
 * so `Resource<'local-command', LocalCommandOutputs>` stays
 * object-shaped, matching the other resource kinds for consistency.
 */
export type LocalCommandOutputs = Record<string, never>;

// =============================================================================
// Internal resource representation
// =============================================================================

/**
 * What the launcher actually sees on a resource. The two public output-type
 * narrowing properties (`__kind`, `__outputs`) plus three runtime carriers
 * (`__id`, `__dependsOn`, `__spec`).
 *
 * Per-instance `__id` is the primary dep-edge match key — it survives the
 * "two copies of the factory code in play" failure mode (the user's repo
 * may have one copy via `bun install`; the global `neon` binary embeds
 * another) better than `===` identity alone.
 *
 * Internal to the launcher; not re-exported from `neonctl/config`.
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
 * tree (plan-time invariant).
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
 * `readiness` if dependents exist.
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
 * `neon.ts` MUST be a `stack({ spec })`.
 *
 * Stack outputs = the record of its children's outputs. TypeScript picks
 * this up automatically from the spec's return type.
 *
 * In v1 a stack must be the ROOT — nested stacks (a stack inside another
 * stack's returned record, or a stack passed via `dependsOn`) are not
 * supported. Use leaf resources directly. Nested stacks may be added later
 * once the runtime can flatten them into the plan registry.
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
}): Resource<'stack', never> {
  // Outputs typed as `never` so a spec callback reading a stack dep's
  // properties gets `never`-typed values — a soft hint that something is
  // off (autocomplete shows nothing useful). The hard reject for
  // nested-stack-as-dep lives in plan.ts; TS does NOT catch it on its
  // own because `never` is assignable to any target type. Drop the
  // `never` when nested-stack composition lands.
  return buildResource<'stack', never, D>('stack', opts);
}

// =============================================================================
// Re-exports from refs.ts so consumers see them via `neonctl/config`
// =============================================================================

export type { Ref } from './refs.js';
