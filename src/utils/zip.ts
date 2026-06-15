import { zipSync } from 'fflate';

// Zip the esbuild output (index.mjs) into the archive the Functions deploy endpoint
// expects. Compression level 6 matches the previous bundler.
export const zipBundle = (entries: Record<string, Uint8Array>): Uint8Array =>
  zipSync(entries, { level: 6 });
