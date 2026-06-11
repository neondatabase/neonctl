import { dirname, isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  loadConfigFromFile,
  resolveConfig,
  type Config,
  type FunctionDevConfig,
} from '@neondatabase/config';

/**
 * A function from `neon.ts`, resolved into everything `neon dev` needs to serve it
 * locally. `source` is absolute (resolved against the `neon.ts` location). `port` is the
 * function's explicit `dev.port`, or `undefined` to let the supervisor find a free one.
 * `env` is the function's own `neon.ts` env, layered over the shared branch env per child.
 */
export type PlannedFunction = {
  slug: string;
  name: string;
  source: string;
  port?: number;
  env: Record<string, string>;
};

/**
 * The result of resolving `neon.ts`: the path to the config file that was loaded (so the
 * dev server can watch it for hot-add/remove of functions) plus the {@link PlannedFunction}s
 * it declares.
 */
export type ResolvedConfigFunctions = {
  /** Absolute path to the loaded `neon.ts` (or `.mts`/`.js`/`.mjs`). */
  configPath: string;
  functions: PlannedFunction[];
};

/**
 * Load `neon.ts` (if any) and resolve the list of functions it declares into
 * {@link PlannedFunction}s for `neon dev` to serve. Returns `null` when there is no
 * `neon.ts` on the path from `cwd` up to the repo root — the caller turns that into a
 * "no --source and no neon.ts" error.
 *
 * `branchName` is used only to evaluate a policy that switches on `branch.name`; the
 * function list is otherwise branch-independent, so a placeholder is fine when unknown.
 */
export const resolveFunctionsFromConfig = async (
  cwd: string,
  branchName?: string,
): Promise<ResolvedConfigFunctions | null> => {
  const loaded = await loadNeonConfig(cwd);
  if (!loaded) return null;

  const { config, configDir, configPath } = loaded;
  const resolved = resolveConfig(config, {
    name: branchName ?? 'local',
    exists: branchName !== undefined,
  });

  const functions = resolved.preview?.functions ?? [];
  const planned = functions.map((fn) => {
    const source = isAbsolute(fn.source)
      ? fn.source
      : resolve(configDir, fn.source);
    if (!existsSync(source)) {
      throw new Error(
        `Function "${fn.slug}" points at a source that does not exist: ${source} ` +
          `(from neon.ts "${fn.source}"). Fix the source path and re-run.`,
      );
    }
    return {
      slug: fn.slug,
      name: fn.name,
      source,
      ...(devPort(fn.dev) !== undefined
        ? { port: devPort(fn.dev) as number }
        : {}),
      env: { ...fn.env },
    };
  });

  return { configPath, functions: planned };
};

/**
 * Read the `port` off a {@link FunctionDevConfig}. `undefined` when no `dev.port` is set
 * (the supervisor then searches for a free port).
 */
const devPort = (dev: FunctionDevConfig | undefined): number | undefined =>
  dev?.port;

type LoadedConfig = { config: Config; configDir: string; configPath: string };

/**
 * Load a `neon.ts` policy if one exists, returning the loaded config, the resolved path to
 * the config file (used by the dev server to watch it), and the directory it lives in (used
 * to resolve each function's relative `source`). Returns `null` when no config file is
 * found; surfaces real load errors (e.g. a syntax error).
 */
const loadNeonConfig = async (cwd: string): Promise<LoadedConfig | null> => {
  try {
    const { config, resolvedPath } = await loadConfigFromFile({ cwd });
    return {
      config,
      configDir: dirname(resolvedPath),
      configPath: resolvedPath,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Could not find a Neon config file/i.test(message)) {
      return null;
    }
    throw err;
  }
};
