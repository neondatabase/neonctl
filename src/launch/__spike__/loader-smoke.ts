/*
 * Spike 0.1 — jiti survives `node pkg.js` (rollup + pkg).
 *
 * Validates that the release pipeline can produce a pkg-bundled binary that
 * loads a user's on-disk `neon.ts` at runtime via `jiti`. See impl-plan
 * Phase 0.1 + spec §11 #42, #43.
 *
 * Function signature: an explicit on-disk path argument (NOT a bundled
 * fixture). A bundled fixture would let pkg copy it into /snapshot/ and the
 * spike would pass spuriously.
 *
 * This file is temporary: deleted before the PR merges (impl-plan §1.4
 * "Spike artifact cleanup"). The runtime loader code that survives lives at
 * `src/launch/plan.ts` per impl-plan Phase 4.1.
 */

import { createJiti } from 'jiti';

export async function loaderSmoke(neonTsPath: string): Promise<void> {
  const jiti = createJiti(import.meta.url);
  const mod = await jiti.import<{ default?: unknown }>(neonTsPath);
  // eslint-disable-next-line no-console
  console.log('loader-smoke:default=' + JSON.stringify(mod.default ?? null));
}
