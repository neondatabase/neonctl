import {
  defineConfig,
  loadConfigFromFile,
  type Config,
  type NeonApi,
} from '@neondatabase/config';
import { pullConfig } from '@neondatabase/config-runtime';
import { fetchEnv, toEntries } from '@neondatabase/env';

import { log } from '../log.js';

export type DevEnvContext = {
  cwd: string;
  projectId?: string;
  branchId?: string;
  apiKey?: string;
  /** Injected NeonApi adapter (tests). Production builds it from `apiKey`. */
  api?: NeonApi;
};

/**
 * Resolve the Neon env vars to inject into a locally-served function, mirroring
 * what the deployed function would receive for the selected branch (pooled /
 * direct `DATABASE_URL`, plus Auth / Data API when enabled).
 *
 * Tiered, and **always degrades gracefully** — a function must still run with no
 * Neon account, no `.neon`, and no network:
 *
 *   1. a `neon.ts` policy is found -> evaluate it with `fetchEnv`
 *   2. no `neon.ts`, but a project + branch are known -> `pullConfig` reads the
 *      branch's live state into a config, then `fetchEnv` injects what's enabled
 *   3. otherwise -> inject nothing
 *
 * Any failure logs a warning and returns `{}` rather than throwing.
 */
export const resolveDevEnv = async (
  ctx: DevEnvContext,
): Promise<Record<string, string>> => {
  try {
    const config = await loadNeonConfig(ctx.cwd);

    if (config) {
      if (!ctx.projectId || !ctx.branchId) {
        log.warning(
          'Found a neon.ts but could not resolve the project/branch to ' +
            'inject env for. Run `neonctl link` and `neonctl checkout <branch>`.',
        );
        return {};
      }
      return await fetchAndProject(config, ctx);
    }

    if (ctx.projectId && ctx.branchId) {
      const pulled = await pullConfig({
        projectId: ctx.projectId,
        branchId: ctx.branchId,
        ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
        ...(ctx.api ? { api: ctx.api } : {}),
      });
      const branchConfig = pulled.config;
      return await fetchAndProject(
        defineConfig(() => branchConfig),
        ctx,
      );
    }

    log.debug(
      'dev: no neon.ts and no project/branch context; skipping env injection',
    );
    return {};
  } catch (err) {
    log.warning(
      'Could not inject Neon env vars; the function will run without them: %s',
      err instanceof Error ? err.message : String(err),
    );
    return {};
  }
};

const fetchAndProject = async (
  config: Config,
  ctx: DevEnvContext,
): Promise<Record<string, string>> => {
  const env = await fetchEnv(config, {
    projectId: ctx.projectId as string,
    branchId: ctx.branchId as string,
    ...(ctx.apiKey ? { apiKey: ctx.apiKey } : {}),
    ...(ctx.api ? { api: ctx.api } : {}),
  });
  return toEntries(env);
};

/**
 * Load a `neon.ts` policy if one exists on the path from `cwd` up to the repo
 * root. Returns `null` when there is none (the common "no config" case), and
 * surfaces real load errors (e.g. a syntax error in an existing file).
 */
const loadNeonConfig = async (cwd: string): Promise<Config | null> => {
  try {
    const { config } = await loadConfigFromFile({ cwd });
    return config;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Could not find a Neon config file/i.test(message)) {
      return null;
    }
    throw err;
  }
};
