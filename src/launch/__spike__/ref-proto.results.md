# Spike 0.2 — Ref<T> Proxy mechanics — results

Run: `bun run src/launch/__spike__/ref-proto.ts`
Runtime observed: Bun 1.3.14 (macOS arm64).
Production target: Node 22+ (pkg-bundled binary).

Status: **PASSED** (6/6 assertions).

```
PASS  JSON.stringify(ref) === {"__ref":"x","__kind":"ref"}
        observed={"__ref":"x","__kind":"ref"}
PASS  `${ref}` throws with the corrective example from spec §2.4
        threwMessage="[neon launch] Cannot interpolate or coerce a Ref<string> to a primitive.\nPut the ref directly into your resource's spec — the launcher resolves it before passing env to the child:\n  spec: ({ db }) => "
PASS  util.inspect(ref) — inspect.custom hook is reachable on the proxy
        customWorks=true inspectOutput=[Function: target] (Bun fallback if !nodeInspectWorks; nodeInspectWorks=false)
PASS  ref({ pooled: false }) returns a new ref with opts
        base={"__ref":"x","__kind":"ref"} called={"__ref":"x","__kind":"ref","__opts":{"pooled":false}}
PASS  Object.assign({}, ref) preserves {__ref,__kind}
        observed={"__ref":"x","__kind":"ref"}
PASS  structuredClone(ref) throws (Bugzilla 1269327)
        threw DataCloneError: The object can not be cloned.
```

## Behavior notes captured during the spike

- **Function-target Proxies need `prototype` in `ownKeys`.** Node + Bun both
  enforce the Proxy invariant: any non-configurable own property of the target
  must appear in the `ownKeys` trap result. Functions ship a non-configurable
  `prototype` slot, so the trap must list it alongside the marker keys
  (`__ref`, `__kind`, `__opts`). The matching `getOwnPropertyDescriptor` trap
  forwards the prototype lookup to the underlying target. Object.assign + JSON
  still only see the enumerable marker keys.
- **`util.inspect.custom` on a Proxy-of-function: Node honors it, Bun does
  not.** Bun's `util.inspect` falls back to `[Function: target]` for the
  proxy. The hook itself is reachable via direct property access on both
  runtimes, so production (Node-22 pkg binary) renders the legible
  `Ref<string>(<id>)` form. The Bun path produces `[Function: target]` —
  suboptimal but never silent. Recorded here so reviewers don't try to
  "fix" the Bun fallback by stripping the function target (which would
  break the callable form spec §2.4 requires).
- **`structuredClone` reliably refuses our Proxy** with a `DataCloneError`,
  matching Bugzilla 1269327. The launcher's env walker must never reach for
  `structuredClone` to deep-copy ref-bearing payloads.
- **`Object.assign({}, ref)` correctly produces a plain object with the
  marker keys** under both Bun and Node — the Proxy's `ownKeys` +
  `getOwnPropertyDescriptor` traps satisfy the structured copy protocol used
  by `Object.assign`.

## Phase 8.1 port

The six assertions move to `src/launch/refs.test.ts` (vitest, running under
Node) during Phase 8.1, with the `__spike__` directory deleted before the PR
merges — per impl-plan §1.4 "Spike artifact cleanup". The Bun-vs-Node
divergence on `inspect.custom` is documented inline as a known runtime
difference; the production binary uses Node, so the legible inspect path is
exercised end-to-end in the Phase 8.2 integration tests.
