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
 * function's explicit `dev.port`, or `undefined` to let the supervisor find a free one
 * (only allowed when not `portless`). `env` is the function's own `neon.ts` env, layered
 * over the shared branch env per child.
 */
export type PlannedFunction = {
  slug: string;
  name: string;
  source: string;
  port?: number;
  portless: boolean;
  env: Record<string, string>;
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
): Promise<PlannedFunction[] | null> => {
  const loaded = await loadNeonConfig(cwd);
  if (!loaded) return null;

  const { config, configDir } = loaded;
  const resolved = resolveConfig(config, {
    name: branchName ?? 'local',
    exists: branchName !== undefined,
  });

  const functions = resolved.preview?.functions ?? [];
  return functions.map((fn) => {
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
      portless: fn.dev?.portless === true,
      ...(devPort(fn.dev) !== undefined
        ? { port: devPort(fn.dev) as number }
        : {}),
      env: { ...fn.env },
    };
  });
};

/**
 * Read the `port` off a {@link FunctionDevConfig}. The discriminated union guarantees a
 * `port` is present whenever `portless` is true, so this is `undefined` only for the
 * non-portless, port-omitted case (the supervisor then searches for a free port).
 */
const devPort = (dev: FunctionDevConfig | undefined): number | undefined =>
  dev?.port;

type LoadedConfig = { config: Config; configDir: string };

/**
 * Load a `neon.ts` policy if one exists, returning the loaded config and the directory
 * it lives in (used to resolve each function's relative `source`). Returns `null` when no
 * config file is found; surfaces real load errors (e.g. a syntax error).
 */
const loadNeonConfig = async (cwd: string): Promise<LoadedConfig | null> => {
  try {
    const { config, resolvedPath } = await loadConfigFromFile({ cwd });
    return { config, configDir: dirname(resolvedPath) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Could not find a Neon config file/i.test(message)) {
      return null;
    }
    throw err;
  }
};
