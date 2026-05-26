export type PsqlVar = {
  name: string;
  value: string;
};

/**
 * Hook callback fired on `\set NAME value` (and synchronously replayed on
 * registration). Mirrors upstream's substitute + assign hook duo in
 * `src/bin/psql/variables.c`.
 *
 * Return semantics:
 *
 *   - `true`  — accept the value; the store keeps it.
 *   - `false` — reject the value with no caller-visible message. The store
 *     keeps the prior value. cmdSet emits a generic "error while setting"
 *     line.
 *   - `string` — reject the value with this error message (no `psql: `
 *     prefix; cmdSet prepends it). Used by special-variable validators so
 *     they can phrase the diagnostic exactly like upstream's
 *     `\<msg> for "<var>"` form.
 */
export type VarHook = (newValue: string | null) => boolean | string;

/**
 * Rich result of `VarStore.trySet`. `cmdSet` consults `reason` to decide
 * whether to emit the upstream-matched "invalid variable name" vs the
 * hook-provided per-variable diagnostic.
 */
export type SetResult =
  | { ok: true }
  | { ok: false; reason: 'invalid-name' }
  | { ok: false; reason: 'hook-veto'; error?: string };

export type VarStore = {
  set(name: string, value: string): boolean;
  /**
   * Variant of {@link set} that returns a discriminated result describing
   * why a set was rejected: `invalid-name` (failed name regex) or
   * `hook-veto` (a registered hook returned `false` or an error string).
   * Hooks may also return a string error; that surfaces as `error` here so
   * the caller can render the upstream-shaped diagnostic.
   */
  trySet(name: string, value: string): SetResult;
  get(name: string): string | undefined;
  unset(name: string): boolean;
  has(name: string): boolean;
  addHook(name: string, hook: VarHook): void;
  entries(): IterableIterator<[string, string]>;
  asBool(name: string, defaultValue?: boolean): boolean;
  asTriple(
    name: string,
    defaultValue: OnOffAuto,
  ): OnOffAuto | { error: string };
  asInt(name: string, defaultValue?: number): number | { error: string };
};

export type OnOffAuto = 'on' | 'off' | 'auto';
