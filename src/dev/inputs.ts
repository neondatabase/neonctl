import { resolve } from 'node:path';

// esbuild's JS module, narrowed to the metafile-producing call we use. Typed
// structurally so we never statically import from 'esbuild' (see resolveInputs
// for why). Mirrors the shape in src/utils/esbuild.ts.
type EsbuildModule = {
  build: (opts: Record<string, unknown>) => Promise<{
    metafile?: { inputs?: Record<string, unknown> };
  }>;
};

export type InputDeps = {
  // @yao-pkg/pkg defines process.pkg inside the packaged binary.
  isPackaged: () => boolean;
  loadEsbuild: (name: string) => Promise<EsbuildModule>;
};

const defaultDeps: InputDeps = {
  isPackaged: () => (process as { pkg?: unknown }).pkg !== undefined,
  loadEsbuild: (name) => import(name) as Promise<EsbuildModule>,
};

/**
 * Resolve the exact set of files esbuild reads to produce the bundle for
 * `source` — the entry plus every local module it imports (npm deps are left
 * external, so they never appear). These are the files the dev watcher should
 * watch, so a single edit triggers exactly one rebuild.
 *
 * Returns absolute paths, or `null` when the precise set cannot be computed —
 * either inside the packaged binary (which cannot import esbuild as a module;
 * it shells out to a binary that has no JSON-metafile equivalent here) or on a
 * platform where the esbuild module won't load. Callers fall back to a coarser
 * watch in that case.
 *
 * This performs a metafile-only pass (`write:false`, `metafile:true`) so it
 * never emits output; the actual bundle bytes still come from `bundleEntry`.
 */
export const resolveWatchInputs = async (
  source: string,
  deps: InputDeps = defaultDeps,
): Promise<string[] | null> => {
  if (deps.isPackaged()) return null;

  // esbuild is resolved by a COMPUTED specifier, never the literal string
  // 'esbuild', for the same reason as src/utils/esbuild.ts: rollup and
  // @yao-pkg/pkg statically scan for literal import()/require() and would pull
  // esbuild's native Go binary into the bundle/snapshot. Keep it invisible.
  const name = ['es', 'build'].join('');
  let esbuild: EsbuildModule;
  try {
    esbuild = await deps.loadEsbuild(name);
  } catch {
    return null;
  }

  let metafile: { inputs?: Record<string, unknown> } | undefined;
  try {
    // Mirrors bundleEntry's flags so the resolved input graph matches the real
    // bundle. metafile:true + write:false makes this a pure analysis pass.
    const result = await esbuild.build({
      entryPoints: [source],
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'node',
      packages: 'external',
      logLevel: 'silent',
    });
    metafile = result.metafile;
  } catch {
    // A bundle error here is non-fatal for watching: bundleEntry surfaces the
    // real diagnostic. Fall back to the coarser watch so edits still rebuild.
    return null;
  }

  const inputs = metafile?.inputs;
  if (!inputs) return null;

  // metafile input keys are paths relative to esbuild's cwd; resolve to absolute
  // so they compare cleanly against chokidar's watched paths.
  return Object.keys(inputs).map((p) => resolve(process.cwd(), p));
};
