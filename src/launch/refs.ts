/**
 * Ref<T> — opaque, lazy outputs the launcher resolves after a resource is
 * provisioned. Runtime + type contract in one place.
 *
 * The six behaviors this module must preserve:
 *
 *   1. JSON.stringify(ref) → {"__ref":"<id>","__kind":"ref"[,"__opts":...]}
 *   2. `${ref}` THROWS with the doc-as-error message
 *   3. util.inspect(ref) → "Ref<string>(<id>)"  (Node honors inspect.custom)
 *   4. ref({ pooled: false }) → new ref tagged with the call's opts
 *   5. Object.assign({}, ref) preserves the marker keys
 *   6. structuredClone(ref) throws (known Proxy incompat — Bugzilla 1269327)
 *
 * Test coverage in src/launch/refs.test.ts.
 */
import { inspect } from 'node:util';

// Opaque brand keyed on a `unique symbol`. The brand makes Ref<string> NOT
// structurally assignable to string — so `const s: string = db.host` is a
// type error. The brand does NOT catch template-string interpolation
// (`${db.host}`); TS lets any object through a template literal as long as
// it has toString. We handle that case at runtime via the Symbol.toPrimitive
// throw below — the throw message IS the corrective documentation.
declare const refBrand: unique symbol;

export type Ref<T> = { readonly [refBrand]: T };

// On-disk shape the env walker matches in plan.ts. The `__opts` slot carries
// per-call payloads (e.g. { pooled: true }) — the launcher uses them to
// re-issue `GET /projects/{id}/connection_uri` per opts-tuple.
export type RefMarker = {
  __ref: string;
  __kind: 'ref';
  __opts?: unknown;
};

/**
 * Build a function-valued Proxy that satisfies the six Ref<T> behaviors above.
 *
 * The function `target` is never invoked directly — the `apply` trap produces
 * a new ref tagged with the call's opts instead. That's the callable form
 * users see when they write `db.connectionString({ pooled: false })`.
 */
export function makeRef<T = string>(id: string, opts?: unknown): Ref<T> {
  const target = function () {
    /* never called — see apply trap */
  } as unknown as object;

  const marker: RefMarker = {
    __ref: id,
    __kind: 'ref',
    ...(opts !== undefined ? { __opts: opts } : {}),
  };

  return new Proxy(target, {
    get(_t, prop) {
      // Throw with a corrective example as the error message.
      // The throw message IS the docs.
      if (prop === Symbol.toPrimitive) {
        return () => {
          throw new Error(
            [
              '[neon launch] Cannot interpolate or coerce a Ref<string> to a primitive.',
              "Put the ref directly into your resource's spec — the launcher resolves it before passing env to the child:",
              '  spec: ({ db }) => ({ env: { DATABASE_URL: db.connectionString } })',
              'Refs are resolved AFTER the resource is provisioned. They are NOT strings at config-evaluation time.',
            ].join('\n'),
          );
        };
      }
      // toJSON returns the marker so JSON.stringify of a function-valued ref
      // preserves the envelope. Without this refs silently drop from env
      // walkers. Returned as a function so JSON.stringify invokes it;
      // JS's own JSON.stringify protocol checks for `.toJSON()`.
      if (prop === 'toJSON') {
        return () => marker;
      }
      // util.inspect → "Ref<string>(<id>[; opts=...])"
      if (prop === inspect.custom) {
        return () =>
          `Ref<string>(${id}${opts !== undefined ? '; opts=' + JSON.stringify(opts) : ''})`;
      }
      if (prop === '__ref' || prop === '__kind' || prop === '__opts') {
        return marker[prop as keyof RefMarker];
      }
      return undefined;
    },
    apply(_t, _thisArg, args: unknown[]) {
      return makeRef<T>(id, args[0]);
    },
    ownKeys() {
      // Marker keys + the non-configurable 'prototype' the function target
      // exposes. The Proxy invariant requires us to list any non-configurable
      // own property of the target.
      const keys = Object.keys(marker);
      keys.push('prototype');
      return keys;
    },
    getOwnPropertyDescriptor(t, prop) {
      if (prop === '__ref' || prop === '__kind' || prop === '__opts') {
        const value = marker[prop as keyof RefMarker];
        if (value === undefined) return undefined;
        return {
          enumerable: true,
          configurable: true,
          writable: false,
          value,
        };
      }
      if (prop === 'prototype') {
        return Object.getOwnPropertyDescriptor(t, 'prototype');
      }
      return undefined;
    },
  }) as unknown as Ref<T>;
}

/**
 * Type guard: is `v` a Ref marker?
 *
 * Used by `walkAndResolve` to identify leaves that need substitution. Tests
 * the runtime `__kind === 'ref'` discriminator — the type-level brand isn't
 * observable at runtime; dispatch by string, never instanceof.
 */
export function isRef(v: unknown): v is RefMarker {
  // `v` may be a function — makeRef wraps a function in a Proxy so the
  // callable form (`db.connectionString({ pooled: true })`) works. A plain
  // `typeof === 'object'` check would skip the function-typed Refs.
  if (v === null) return false;
  if (typeof v !== 'object' && typeof v !== 'function') return false;
  return (
    (v as RefMarker).__kind === 'ref' &&
    typeof (v as RefMarker).__ref === 'string'
  );
}
