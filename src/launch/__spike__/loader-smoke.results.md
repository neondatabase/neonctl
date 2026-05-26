# Spike 0.1 — jiti through `node pkg.js` — results

Run: `bun run /tmp/run-spike.ts` (which spawns
`bundle/neonctl-<target> loader-smoke /tmp/spike-test/neon.ts` via
`child_process.spawnSync`).

Steps executed:

1. `bun add jiti` → installed `jiti@2.7.0` (the version validated in this spike).
2. `bun run build` → tsc emit, including `dist/launch/__spike__/loader-smoke.js`.
3. `node pkg.js` → rollup succeeded, produced
   `bundle/loader-smoke-6da79863.js` (192 KB; jiti's source is inlined).
   pkg packaged `bundle/neonctl-{linux-x64,linux-arm64,macos-x64,win-x64}`.
4. Ran `bundle/neonctl-macos-x64 loader-smoke /tmp/spike-test/neon.ts`
   against a sentinel `neon.ts` written immediately before the invocation.

Status: **FAILED** (runtime binary).

## Observed output

```
spike-bin: /Users/guillaume.rivals/Developer/neondatabase/neonctl/bundle/neonctl-macos-x64
spike-input: /tmp/spike-test/neon.ts (sentinel=spike-1779781728906)
stdout:
stderr: node:internal/modules/cjs/loader:1387
  const err = new Error(message);
              ^

Error: Cannot find module '../dist/babel.cjs'
Require stack:
- /snapshot/neonctl/bundle/loader-smoke-6da79863.js
1) If you want to compile the package/file into executable, please pay
   attention to compilation warnings and specify a literal in 'require' call.
2) If you don't want to compile the package/file into executable and want to
   'require' it from filesystem (likely plugin), specify an absolute path in
   'require' call using process.cwd() or process.execPath.
    at Function.<anonymous> (node:internal/modules/cjs/loader:1387:15)
    at Function._resolveFilename (pkg/prelude/bootstrap.js:1959:46)
    ...
    at Module.<anonymous> (node:internal/modules/cjs/loader:1467:12)
  code: 'MODULE_NOT_FOUND',
  requireStack: [ '/snapshot/neonctl/bundle/loader-smoke-6da79863.js' ],
  pkg: true

Node.js v22.21.1

status: 1

Spike 0.1 FAILED — output mismatch.
```

Reproduced on two consecutive runs with fresh sentinels — not a flake.

## Diagnosis

jiti's runtime path lazy-requires `../dist/babel.cjs` (jiti uses Babel for the
TS transform). Rollup inlined the surrounding source, but the `require(
'../dist/babel.cjs')` literal survives in the bundle, and pkg's snapshot fs
can't resolve a relative path that points OUT of `bundle/` into the original
`node_modules/jiti/dist/`. This is the impl-plan §0.1 + spec §11 #42 failure
mode in the second variant: "pkg fails or the runtime binary throws at jiti's
dynamic require."

The bundle DOES contain a literal string `../dist/babel.cjs` (confirmed via
`grep -o '[^,\\'"\)]*babel\.cjs[^,\\'"\)]*' bundle/loader-smoke-*.js`).

## Per impl-plan §0.3 — halting

> Spike fallbacks above are documented for human triage, not auto-execution.
> The "improvise a new design under deadline" failure mode is what 9 spec
> rounds of review were preventing — don't waste it.

I am not auto-executing any of the three documented fallbacks:

1. Switch loader to `esbuild.transformSync` + `vm.runInThisContext` (drops
   native TS-imports inside `neon.ts`).
2. Drop the pkg-binary distribution for `launch` (require `bun`/`node` on
   PATH; runtime guard fires if neither present).
3. Combined: keep `jiti` for `npm i -g`, ship a different loader for the pkg
   binary path. Adds release-branch complexity.

A separate option worth surfacing for the human triage: the impl-plan §0.1
step 5 "rollup fails" branch suggests marking `jiti` as `external` in
`pkg.js`'s rollup config. That remediation is plan-documented for the
ROLLUP-FAILS case (which didn't fire here — rollup succeeded). It MIGHT also
fix the pkg-runtime case by leaving `jiti` resolvable inside the snapshot's
`node_modules/jiti/dist/babel.cjs` instead of buried inside a rolled-up
bundle. I did NOT try it — the plan explicitly scopes that remediation to a
different failure mode, and §0.3 forbids improvising fallbacks under time
pressure. Listing it here so the human can decide whether to extend the
plan's remediation table to cover this case before the next iteration.

## Reproducibility checklist

For the human re-running the spike:

```bash
# Working tree at gr/neon-launch with this commit applied.
cd <repo>
bun install                                  # picks up jiti@2.7.0 from package.json
bun run build                                # emits dist/launch/__spike__/
bun run /tmp/run-pkg.ts || node pkg.js       # builds bundle/neonctl-<target>
bun run /tmp/run-spike.ts neonctl-macos-x64  # adjust target for the host
```

Expected on FAIL: stderr shows `Cannot find module '../dist/babel.cjs'`,
status=1. Expected on PASS:
`loader-smoke:default={"sentinel":"spike-<timestamp>"}`, status=0.
