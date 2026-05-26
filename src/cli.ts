#!/usr/bin/env node

// SPIKE 0.1 — temporary entrypoint guard so rollup + pkg see the loader
// import. Remove before merging the PR. See src/launch/__spike__/loader-smoke.ts.
if (process.argv[2] === 'loader-smoke') {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  import('./launch/__spike__/loader-smoke.js').then(async (m) => {
    const pathArg = process.argv[3];
    if (!pathArg) {
      // eslint-disable-next-line no-console
      console.error('usage: neonctl loader-smoke <path-to-neon.ts>');
      process.exit(2);
    }
    await m.loaderSmoke(pathArg);
    process.exit(0);
  });
} else {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  import('./index.js');
}
