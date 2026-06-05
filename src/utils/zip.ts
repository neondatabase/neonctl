import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { zipSync } from 'fflate';

const EXCLUDED_DIRS = new Set(['.git', 'node_modules']);

// Walk `dir` and return a flat map of POSIX-relative path -> file bytes.
// Excludes .git and node_modules. Skips symlinks (does not follow them).
export const collectFiles = (dir: string): Record<string, Uint8Array> => {
  const files: Record<string, Uint8Array> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        const rel = relative(dir, abs).split(sep).join('/');
        files[rel] = new Uint8Array(readFileSync(abs));
      }
    }
  };
  walk(dir);
  return files;
};

export const buildZip = (dir: string): Uint8Array => zipSync(collectFiles(dir));

// Zip the esbuild output (out.js + out.js.map) into the archive the Functions
// deploy endpoint expects. Compression level 6 matches the previous bundler.
export const zipBundle = (entries: Record<string, Uint8Array>): Uint8Array =>
  zipSync(entries, { level: 6 });
