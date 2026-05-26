/**
 * User-facing error message templates for plan-time and runtime failures.
 *
 * The throw message IS the docs. Each template takes a context object so the
 * launcher can fill in the specifics.
 */

// =============================================================================
// Exit codes
// =============================================================================

export const ExitCode = {
  SUCCESS: 0,
  RESOURCE_FAILED: 1,
  CONFIG_ERROR: 2,
  AUTH_MISSING: 3,
  SIGINT: 130,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Error that carries a specific exit code so the CLI handler can surface
 * it instead of always exiting 1. Use this for category errors the user
 * can act on (CONFIG_ERROR for plan-time, AUTH_MISSING for missing
 * tokens). Bare `throw new Error(...)` still resolves to RESOURCE_FAILED.
 */
export class LaunchError extends Error {
  readonly exitCode: ExitCode;
  // Explicit exit code is required: defaulting would silently mis-classify
  // a future internal-bug throw as CONFIG_ERROR (telling the user "fix your
  // config" when the launcher itself is wrong). Plain `throw new Error(...)`
  // still falls through to RESOURCE_FAILED via the handler in commands/launch.ts.
  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = 'LaunchError';
    this.exitCode = exitCode;
  }
}

// =============================================================================
// 5.1 Duplicate identity at two record keys
// =============================================================================

/**
 * Fires when a stack's returned record has the SAME resource value (by
 * `__id`/`===` identity) at two different keys. Almost always a typo.
 *
 * The helper example shows `localCommand` because users hit this most
 * often on commands (workers, seeders). For `postgres` the singleton
 * check fires separately; for the rare "two genuine instances" case the
 * helper pattern is the right corrective.
 */
export function dupKeyMessage(opts: {
  stackName: string;
  keyA: string;
  keyB: string;
  kind: string;
}): string {
  return [
    `[neon launch] Stack '${opts.stackName}' returns the same resource at two keys: '${opts.keyA}' and '${opts.keyB}'.`,
    `Both record entries point to the same \`${opts.kind}(...)\` value.`,
    '',
    `Each key in a stack's record provisions one resource. Two keys → one value is`,
    `almost always a typo — either rename one of the consts and declare them`,
    `separately, or remove the duplicate key.`,
    '',
    `If you actually want two independent instances with similar specs, wrap the`,
    `constructor in a helper that returns a fresh resource on each call:`,
    '',
    `  const makeSeed = (table: string) => localCommand({`,
    `    spec: ({ db }) => ({`,
    `      command: \`npm run seed:\${table}\`,`,
    `      env: { DATABASE_URL: db.connectionString },`,
    `      readiness: { onExit: 0 },          // one-shot — exits when done`,
    `    }),`,
    `    dependsOn: { db },`,
    `  });`,
    '',
    `  return {`,
    `    db,`,
    `    ${opts.keyA}:    makeSeed('${opts.keyA}'),`,
    `    ${opts.keyB}: makeSeed('${opts.keyB}'),`,
    `  };`,
  ].join('\n');
}

// =============================================================================
// 5.2 Postgres singleton constraint
// =============================================================================

/**
 * Fires when the resolved tree contains 0 or >1 resources with __kind === 'postgres'.
 * The dup-key check runs FIRST — if the same postgres value appears at
 * two record keys, the user sees the dup-key error, not this one.
 */
export function singletonMessage(opts: {
  count: number;
  names: string[];
}): string {
  if (opts.count === 0) {
    return [
      `[neon launch] Found 0 postgres resources in the launch tree; expected exactly 1.`,
      '',
      `v1 of \`neon launch\` provisions exactly one Neon Postgres branch per launch.`,
      `Add a \`postgres({...})\` to your stack and return it.`,
      '',
      `Multi-postgres support is tied to how Neon projects map to a Postgres endpoint;`,
      `we may relax this if the platform shape changes.`,
    ].join('\n');
  }
  return [
    `[neon launch] Found ${opts.count} postgres resources in the launch tree; expected exactly 1.`,
    `Found at: ${opts.names.join(', ')}`,
    '',
    `Pick one; either remove the extra(s) or move them behind a flag your \`spec\``,
    `reads from \`ctx\`. v1 caps at one postgres per launch.`,
  ].join('\n');
}

// =============================================================================
// 5.3 Branch quota exceeded
// =============================================================================

export function branchQuotaMessage(opts: {
  projectId: string;
  limit?: number;
}): string {
  return [
    `[neon launch] Branch limit reached for project ${opts.projectId}.`,
    opts.limit
      ? `Your Neon plan caps at ${opts.limit} branches per project; you're at the limit.`
      : `Your Neon plan's branch cap has been reached.`,
    '',
    `Delete unused branches:`,
    `  neon branches list --project-id ${opts.projectId}`,
    `  neon branches delete <branch_name>`,
    '',
    `Or upgrade the project: https://console.neon.tech/app/projects/${opts.projectId}/settings`,
    '',
    `(Free tier caps at 10 — see https://neon.com/docs/introduction/plans)`,
  ].join('\n');
}

// =============================================================================
// Vercel token missing
// =============================================================================

export function vercelTokenMissingMessage(): string {
  return [
    `[neon launch] VERCEL_TOKEN is required when a vercelDeployment is in scope.`,
    `Create one at https://vercel.com/account/tokens and re-run.`,
  ].join('\n');
}

// =============================================================================
// Stack spec returned the wrong shape
// =============================================================================

export function stackSpecNotRecordMessage(opts: {
  stackName: string;
  got: string;
}): string {
  return [
    `[neon launch] Stack '${opts.stackName}' spec did not return a record of resources (got ${opts.got}).`,
    '',
    `A stack's spec callback must return an object literal whose values are`,
    `the result of factory calls (postgres, vercelDeployment, localCommand).`,
    `Example:`,
    '',
    `  export default stack({`,
    `    spec: (_, { gitBranch }) => {`,
    `      const db = postgres({ spec: () => ({ name: gitBranch || 'main' }) });`,
    `      return { db };`,
    `    },`,
    `  });`,
  ].join('\n');
}

// =============================================================================
// Cycle detected in resource dependencies
// =============================================================================

export function cycleDetectedMessage(opts: { involved: string[] }): string {
  return [
    `[neon launch] Cycle detected in resource dependencies.`,
    `Involved resources: ${opts.involved.join(', ')}.`,
    '',
    `One resource depends on another (transitively) that depends back on it.`,
    `Inspect the \`dependsOn:\` blocks on those resources and break the loop`,
    `by inverting an edge, or by lifting shared init into a leaf both`,
    `dependents can attach to.`,
  ].join('\n');
}
