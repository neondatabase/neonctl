import type { ResolvedBranchConfig } from '@neondatabase/config';
import type { PulledBranchConfig } from '@neondatabase/config-runtime';

/**
 * Render a TTL in whole seconds back to the canonical `neon.ts` duration string (e.g.
 * `604800` -> `"7d"`), falling back to seconds when no clean unit boundary matches. Mirrors
 * the formatter `@neondatabase/config` uses when it emits a TTL, so `config status` shows
 * the same value a user would write in `neon.ts`.
 */
export const formatDurationSeconds = (totalSeconds: number): string => {
  const units = [
    ['w', 7 * 24 * 60 * 60],
    ['d', 24 * 60 * 60],
    ['h', 60 * 60],
    ['m', 60],
  ] as const;
  for (const [unit, perUnit] of units) {
    if (totalSeconds % perUnit === 0) return `${totalSeconds / perUnit}${unit}`;
  }
  return `${totalSeconds}s`;
};

/**
 * The `neon.ts`-shaped view of a branch's live configuration, mirroring how a user would
 * author it in `defineConfig({ ... })` — minus the `branch` *closure* wrapper, since the
 * remote only has concrete resolved values. Every field is omitted when it carries no
 * signal (a disabled service, an empty preview), so `config status` reads like a minimal
 * `neon.ts`.
 */
export type NeonConfigView = {
  auth?: true;
  dataApi?: true;
  preview?: {
    aiGateway?: true;
    functions?: Record<string, { name: string }>;
    buckets?: Record<string, { access: string }>;
  };
  branch?: {
    parent?: string;
    ttl?: string;
    protected?: boolean;
    postgres?: ResolvedBranchConfig['postgres'];
  };
};

/**
 * Project a resolved branch config (plus the separately-pulled preview state, since
 * functions/buckets don't live on the closure) into a {@link NeonConfigView}.
 *
 * - Service toggles are surfaced as `true` only when enabled (disabled is the absence of
 *   the key, exactly as in `neon.ts`).
 * - `ttlSeconds` is rendered back to a duration string (`7d`).
 * - The `branch` section is the JSON-able part of what would otherwise be the `branch`
 *   closure: `parent` / `ttl` / `protected` / `postgres.computeSettings`.
 * - `branch` and `preview` are omitted entirely when they would be empty.
 */
export const toNeonConfigView = (
  resolved: ResolvedBranchConfig,
  preview: PulledBranchConfig['preview'],
): NeonConfigView => {
  const view: NeonConfigView = {};

  if (resolved.authEnabled) view.auth = true;
  if (resolved.dataApiEnabled) view.dataApi = true;

  const previewView = toPreviewView(preview);
  if (previewView) view.preview = previewView;

  const branch: NeonConfigView['branch'] = {};
  if (resolved.parent !== undefined) branch.parent = resolved.parent;
  if (resolved.ttlSeconds !== undefined)
    branch.ttl = formatDurationSeconds(resolved.ttlSeconds);
  if (resolved.protected !== undefined) branch.protected = resolved.protected;
  if (resolved.postgres?.computeSettings) branch.postgres = resolved.postgres;
  if (Object.keys(branch).length > 0) view.branch = branch;

  return view;
};

const toPreviewView = (
  preview: PulledBranchConfig['preview'],
): NeonConfigView['preview'] | undefined => {
  if (!preview) return undefined;
  const out: NonNullable<NeonConfigView['preview']> = {};
  if (preview.aiGatewayEnabled) out.aiGateway = true;
  if (preview.functions.length > 0) {
    out.functions = Object.fromEntries(
      preview.functions.map((fn) => [fn.slug, { name: fn.name }]),
    );
  }
  if (preview.buckets.length > 0) {
    out.buckets = Object.fromEntries(
      preview.buckets.map((b) => [b.name, { access: b.access }]),
    );
  }
  return Object.keys(out).length > 0 ? out : undefined;
};
