/**
 * Public re-export surface for `neonctl/config`.
 *
 * `package.json` `exports["./config"]` points at the compiled `dist/launch-config.{js,d.ts}`.
 * This file just forwards everything from `src/launch/config.ts` so the
 * internal `src/launch/` tree can move/refactor without churning consumers.
 *
 * See spec §2.3 for the type contract this surface freezes.
 */
export * from './launch/config.js';
