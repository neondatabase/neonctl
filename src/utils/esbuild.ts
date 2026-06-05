import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import which from 'which';

const NOT_FOUND =
  'esbuild not found. Install esbuild and ensure it is on your PATH to ' +
  'deploy functions (e.g. npm i -g esbuild).';

// Find the esbuild binary at deploy time. An explicit override is authoritative
// (so it fails loudly if wrong); otherwise prefer the host PATH, then a locally
// installed copy. esbuild is never a shipped dependency of neonctl.
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
    // esbuild's stderr is captured into a buffer (NOT inherited): with
    // --log-level=error a success emits nothing, and a failure's diagnostic is
    // read out below for the error message. Never switch this to 'inherit'.
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

// Bundle `source` with the esbuild CLI and return the emitted files keyed by
// basename. Mirrors the flags the previous config-runtime bundler used.
export const bundleEntry = async (
  source: string,
): Promise<Record<string, Uint8Array>> => {
  const bin = resolveEsbuild();
  const outDir = mkdtempSync(join(tmpdir(), 'neon-fn-bundle-'));
  const outfile = join(outDir, 'out.js');
  try {
    const { code, stderr } = await runEsbuild(bin, [
      source,
      '--bundle',
      `--outfile=${outfile}`,
      '--sourcemap',
      '--minify',
      '--format=esm',
      '--platform=node',
      '--packages=external',
      '--log-level=error',
    ]);
    // Non-zero exit, or null (killed by signal): treat as a bundle failure.
    if (code !== 0) {
      throw new Error(
        `Failed to bundle function from ${source}. ${stderr.trim()}`.trim(),
      );
    }
    return {
      'out.js': new Uint8Array(readFileSync(outfile)),
      'out.js.map': new Uint8Array(readFileSync(`${outfile}.map`)),
    };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
};
