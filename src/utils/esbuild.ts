import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import which from 'which';

const NOT_FOUND =
  'esbuild not found. neonctl ships esbuild for most platforms; if you see ' +
  'this, install esbuild and ensure it is on your PATH (e.g. `npm i -g ' +
  'esbuild`), or set NEON_ESBUILD_PATH to an esbuild binary.';

// Prepended to the ESM bundle. Bundled dependencies are frequently CommonJS, but an ESM
// output (`--format=esm`) has no `require` / `__filename` / `__dirname` in scope — so any
// bundled CJS code that calls `require(...)` would fail at load with
// `Dynamic require of "x" is not supported`. Re-create those globals via `createRequire`
// so CJS and ESM dependencies coexist in the single `index.mjs`.
const ESM_CJS_INTEROP_BANNER =
  "import{createRequire as ___cr}from'module';import{fileURLToPath as ___f}from'url';import{dirname as ___d}from'path';const require=___cr(import.meta.url);const __filename=___f(import.meta.url);const __dirname=___d(__filename);";

// esbuild's JS module, narrowed to the one call we use. Typed structurally so
// we never statically import from 'esbuild' (see bundleViaModule for why).
type EsbuildModule = {
  build: (opts: Record<string, unknown>) => Promise<{
    outputFiles?: readonly { path: string; contents: Uint8Array }[];
  }>;
};

export type BundleDeps = {
  isPackaged: () => boolean;
  loadEsbuild: (name: string) => Promise<EsbuildModule>;
};

const defaultDeps: BundleDeps = {
  // @yao-pkg/pkg defines process.pkg inside the packaged binary.
  isPackaged: () => (process as { pkg?: unknown }).pkg !== undefined,
  loadEsbuild: (name) => import(name) as Promise<EsbuildModule>,
};

// Internal signal: the esbuild JS module could not be imported (exotic platform
// or not installed). Tells bundleEntry to fall back to the binary; never shown
// to the user.
class ModuleNotAvailable extends Error {}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const toFilesByBasename = (
  files: readonly { path: string; contents: Uint8Array }[],
): Record<string, Uint8Array> => {
  const out: Record<string, Uint8Array> = {};
  for (const f of files) out[basename(f.path)] = f.contents;
  return out;
};

const bundleViaModule = async (
  source: string,
  loadEsbuild: BundleDeps['loadEsbuild'],
): Promise<Record<string, Uint8Array>> => {
  // esbuild is resolved by a COMPUTED specifier, never the literal string
  // 'esbuild'. Both rollup (bundle step) and @yao-pkg/pkg (binary step)
  // statically scan for literal import()/require() calls and would otherwise
  // pull esbuild and its native Go binary into the bundle/snapshot — bloating
  // the packaged CLI and emitting "cannot bundle native binary" warnings. The
  // packaged binary never imports esbuild at all (the isPackaged guard sends it
  // to the binary path), so keeping this specifier invisible to the scanners is
  // what keeps esbuild out of the snapshot.
  // Do NOT "simplify" this back to import('esbuild').
  const name = ['es', 'build'].join('');
  let esbuild: EsbuildModule;
  try {
    esbuild = await loadEsbuild(name);
  } catch {
    throw new ModuleNotAvailable();
  }
  // Mirrors the binary-path bundling flags; write:false keeps output in memory.
  // logLevel:'silent' suppresses esbuild's own stderr — the rejected error
  // still carries the diagnostic, matching the binary path's captured-stderr.
  const result = await esbuild
    .build({
      entryPoints: [source],
      bundle: true,
      // Emit `index.mjs` (not `out.js`): the Functions runtime imports the archive's entry
      // by the conventional `index.{js,mjs}` name, and `.mjs` makes Node treat the ESM
      // output as a module without needing a `package.json` type marker alongside it.
      outfile: 'index.mjs',
      write: false,
      minify: true,
      format: 'esm',
      platform: 'node',
      // Bundle dependencies into the entry so the deployed archive is self-contained (the
      // Functions runtime has no node_modules). Node built-ins stay external on
      // platform:'node'. The banner re-creates require/__filename/__dirname for bundled CJS.
      banner: { js: ESM_CJS_INTEROP_BANNER },
      logLevel: 'silent',
    })
    .catch((err: unknown) => {
      throw new Error(
        `Failed to bundle function from ${source}. ${message(err)}`.trim(),
      );
    });
  const files = result.outputFiles ?? [];
  // write:false with one entry always yields index.mjs (no source map — we don't emit one);
  // an empty set means the API contract changed under us — fail loud rather than ship an
  // empty archive.
  if (files.length === 0) {
    throw new Error(
      `Failed to bundle function from ${source}. esbuild produced no output.`,
    );
  }
  return toFilesByBasename(files);
};

// Find the esbuild binary at deploy time. An explicit override is authoritative
// (so it fails loudly if wrong); otherwise prefer the host PATH, then a locally
// installed copy.
const resolveEsbuild = (): string => {
  const override = process.env.NEON_ESBUILD_PATH;
  if (override) {
    if (existsSync(override)) return override;
    throw new Error(NOT_FOUND);
  }
  const onPath = which.sync('esbuild', { nothrow: true });
  if (onPath) return onPath;
  // CWD-relative (not install-relative): helps the dev checkout where esbuild is
  // a devDependency. In `npm i -g` and pkg installs the PATH branch above wins.
  const local = join(process.cwd(), 'node_modules', '.bin', 'esbuild');
  if (existsSync(local)) return local;
  throw new Error(NOT_FOUND);
};

const runEsbuild = (
  bin: string,
  args: string[],
): Promise<{ code: number | null; stderr: string }> =>
  new Promise((resolve, reject) => {
    // stderr is captured (NOT inherited): with --log-level=error a success emits
    // nothing, and a failure's diagnostic is read out below. Never use 'inherit'.
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stderr });
    });
  });

const bundleViaBinary = async (
  source: string,
): Promise<Record<string, Uint8Array>> => {
  const bin = resolveEsbuild();
  const outDir = mkdtempSync(join(tmpdir(), 'neon-fn-bundle-'));
  const outfile = join(outDir, 'index.mjs');
  try {
    const { code, stderr } = await runEsbuild(bin, [
      source,
      '--bundle',
      `--outfile=${outfile}`,
      '--minify',
      '--format=esm',
      '--platform=node',
      `--banner:js=${ESM_CJS_INTEROP_BANNER}`,
      '--log-level=error',
    ]);
    if (code !== 0) {
      throw new Error(
        `Failed to bundle function from ${source}. ${stderr.trim()}`.trim(),
      );
    }
    // No `--sourcemap`: the Functions runtime has no source-map support, so an uploaded
    // `index.mjs.map` is never consumed — emitting it only inflated the archive.
    return {
      'index.mjs': new Uint8Array(readFileSync(outfile)),
    };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
};

// Bundle `source` into the files the Functions archive expects, keyed by
// basename. npm installs bundle in-process via the esbuild module; the packaged
// binary (and platforms esbuild can't run on) shell out to an esbuild binary.
export const bundleEntry = async (
  source: string,
  deps: BundleDeps = defaultDeps,
): Promise<Record<string, Uint8Array>> => {
  if (deps.isPackaged()) return bundleViaBinary(source);
  try {
    return await bundleViaModule(source, deps.loadEsbuild);
  } catch (err) {
    if (err instanceof ModuleNotAvailable) return bundleViaBinary(source);
    throw err;
  }
};
