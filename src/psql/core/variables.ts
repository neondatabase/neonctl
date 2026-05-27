/**
 * psql Variables store.
 *
 * TypeScript port of PostgreSQL's `src/bin/psql/variables.c`. Models a psql
 * "variable space" — a name → string-value mapping with per-variable
 * notification hooks and the parsing helpers psql uses to coerce values to
 * booleans, tri-state ("on"/"off"/"auto") values, and integers.
 *
 * Deviations from upstream that are intentional:
 *
 *  - Storage is a `Map<string, string>` rather than a doubly-linked list.
 *    Insertion order is preserved by Map (psql sorts alphabetically purely for
 *    pretty-printing in `\set`; that responsibility belongs to a future
 *    printer/help WP, not the store).
 *  - Multiple hooks per name are allowed (upstream has at most one substitute
 *    + one assign hook per variable). All hooks must return `true` for a
 *    `set()` to be accepted; if any vetoes, the value is left unchanged.
 *  - On `addHook()` we synchronously replay the current value (or `null` if
 *    unset) through the new hook. This matches the upstream behaviour where
 *    `SetVariableHooks` fires the substitute and assign hooks immediately so
 *    derived psql state can sync.
 *  - On `unset()` registered hooks are notified with `null` and remain
 *    registered. The value is removed from the map (so `has()` returns
 *    `false`), but a later `set()` will still consult the hooks.
 *  - Variable names are validated against `[A-Za-z_][A-Za-z0-9_]*` per the
 *    WP-06 spec. Upstream additionally accepts non-ASCII bytes and a leading
 *    digit; we deliberately tighten the rule for the TS port.
 */

import type {
  OnOffAuto,
  SetResult,
  VarHook,
  VarStore as VarStoreType,
} from '../types/variables.js';

const VALID_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Case-insensitive prefix match: does `value` start with `prefix`? */
const isPrefixOf = (value: string, prefix: string): boolean =>
  value.length > 0 &&
  value.length <= prefix.length &&
  prefix.slice(0, value.length).toLowerCase() === value.toLowerCase();

/**
 * Parse a string the way psql's `ParseVariableBool` does.
 *
 * Recognised tokens (case-insensitive, with unique-prefix matching for the
 * word forms): `true`, `false`, `yes`, `no`, `on`, `off`, `1`, `0`. For `on`
 * and `off` we require at least two characters of input — a bare `o` is
 * ambiguous and upstream rejects it.
 *
 * Returns the parsed boolean, or `null` if the string is not recognised.
 */
const parseBool = (value: string): boolean | null => {
  if (value.length === 0) return null;

  if (isPrefixOf(value, 'true')) return true;
  if (isPrefixOf(value, 'false')) return false;
  if (isPrefixOf(value, 'yes')) return true;
  if (isPrefixOf(value, 'no')) return false;

  // 'on'/'off' need at least 2 chars; 'o' alone is ambiguous.
  if (value.length >= 2) {
    const lower = value.toLowerCase();
    if ('on'.startsWith(lower)) return true;
    if ('off'.startsWith(lower)) return false;
  }

  if (value === '1') return true;
  if (value === '0') return false;

  // WP-06 extension: any other strtol-parsable integer is truthy if non-zero,
  // falsy if zero. Upstream `ParseVariableBool` rejects "42" outright; we
  // accept it so callers don't need a separate code path for numeric flags.
  const asNum = parseInt32(value);
  if (asNum !== null) return asNum !== 0;

  return null;
};

/**
 * Parse a string as an integer the way psql's `ParseVariableNum` does
 * (base 0, i.e. `0x` and leading-zero octal forms are accepted), and clamp
 * to the 32-bit signed range that psql uses (the C cast `numval == (int)
 * numval` check).
 *
 * Returns the integer, or `null` on syntax / range failure.
 */
const parseInt32 = (value: string): number | null => {
  if (value.length === 0) return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  // Match the prefixes strtol(_, _, 0) accepts and pick the matching radix
  // explicitly so we can validate the entire string (Number()/parseInt with
  // base 0 are not portable enough for this).
  let body = trimmed;
  let sign = 1;
  if (body.startsWith('+')) {
    body = body.slice(1);
  } else if (body.startsWith('-')) {
    sign = -1;
    body = body.slice(1);
  }
  if (body.length === 0) return null;

  let radix = 10;
  if (body.startsWith('0x') || body.startsWith('0X')) {
    radix = 16;
    body = body.slice(2);
  } else if (body.startsWith('0o') || body.startsWith('0O')) {
    radix = 8;
    body = body.slice(2);
  } else if (body.length > 1 && body.startsWith('0')) {
    // C strtol with base 0 treats a leading 0 as octal. JS users typically
    // expect decimal; we follow upstream for behavioural fidelity.
    radix = 8;
    body = body.slice(1);
  }
  if (body.length === 0) return null;

  const digitRe =
    radix === 16 ? /^[0-9a-fA-F]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!digitRe.test(body)) return null;

  const parsed = sign * parseInt(body, radix);
  if (!Number.isFinite(parsed)) return null;
  // Match `numval == (int) numval` — 32-bit signed range.
  if (parsed < -0x80000000 || parsed > 0x7fffffff) return null;
  return parsed;
};

export class VarStore implements VarStoreType {
  private readonly values = new Map<string, string>();
  private readonly hooks = new Map<string, VarHook[]>();

  set(name: string, value: string): boolean {
    return this.trySet(name, value).ok;
  }

  trySet(name: string, value: string): SetResult {
    if (!VALID_NAME_RE.test(name)) {
      return { ok: false, reason: 'invalid-name' };
    }

    const hooks = this.hooks.get(name);
    let toStore = value;
    if (hooks) {
      // All hooks must accept the value. Each hook can either:
      //   - return `true` to accept as-is,
      //   - return `false` to reject silently (the prior value is kept),
      //   - return a `string` to reject with that error message
      //     (cmdSet renders it with the `psql: ` prefix), or
      //   - return `{ substitute: '<value>' }` to rewrite the stored value
      //     before subsequent hooks see it.
      //
      // The substitute return is the collapsed equivalent of upstream's
      // separate substitute/assign hook pair (see
      // `bool_substitute_hook` + `bool_assign_hook` in `command.c`).
      // Hooks are responsible for ensuring their substituted value passes
      // their own validation — we do NOT re-run a hook against its own
      // substitution.
      for (const hook of hooks) {
        const result = hook(toStore);
        if (result === false) {
          return { ok: false, reason: 'hook-veto' };
        }
        if (typeof result === 'string') {
          return { ok: false, reason: 'hook-veto', error: result };
        }
        if (typeof result === 'object' && result !== null) {
          toStore = result.substitute;
        }
      }
    }
    this.values.set(name, toStore);
    return { ok: true };
  }

  get(name: string): string | undefined {
    return this.values.get(name);
  }

  unset(name: string): boolean {
    const had = this.values.delete(name);
    const hooks = this.hooks.get(name);
    if (hooks) {
      // Notify hooks of deletion so they can clear derived state.
      // Upstream substitute hooks (e.g. `on_error_rollback_substitute_hook`,
      // `bool_substitute_hook`) re-inject a default when `newval == NULL` —
      // so `\unset ON_ERROR_ROLLBACK` actually re-stores "off",
      // `\unset AUTOCOMMIT` re-stores "on", etc. Honor the substitute by
      // re-storing the value the hook returns. Plain `true` / `false` /
      // error-string returns mean "no substitute" and the slot stays empty.
      let substituted: string | null = null;
      for (const hook of hooks) {
        const r = hook(null);
        if (typeof r === 'object' && r !== null && 'substitute' in r) {
          substituted = r.substitute;
        }
      }
      if (substituted !== null) {
        this.values.set(name, substituted);
        // Re-notify hooks with the substituted value so derived state
        // (settings.onErrorRollback, etc.) gets the correct default.
        for (const hook of hooks) hook(substituted);
      }
    }
    return had;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  addHook(name: string, hook: VarHook): void {
    if (!VALID_NAME_RE.test(name)) return;

    const existing = this.hooks.get(name);
    if (existing) {
      existing.push(hook);
    } else {
      this.hooks.set(name, [hook]);
    }
    // Replay the current value so the hook can sync immediately, matching
    // upstream `SetVariableHooks` semantics.
    const current = this.values.get(name);
    hook(current ?? null);
  }

  entries(): IterableIterator<[string, string]> {
    return this.values.entries();
  }

  asBool(name: string, defaultValue = false): boolean {
    const value = this.values.get(name);
    if (value === undefined) return defaultValue;
    const parsed = parseBool(value);
    return parsed ?? defaultValue;
  }

  asTriple(
    name: string,
    defaultValue: OnOffAuto,
  ): OnOffAuto | { error: string } {
    const value = this.values.get(name);
    if (value === undefined) return defaultValue;

    // "auto" is matched first as a unique prefix, so "a", "au", "aut",
    // "auto" all map to 'auto'. psql's actual call site does an
    // `pg_strncasecmp(value, "auto", len)` before falling through to
    // ParseVariableBool — we do the same.
    if (isPrefixOf(value, 'auto')) return 'auto';

    const parsed = parseBool(value);
    if (parsed === null) {
      return {
        error: `unrecognized value "${value}" for "${name}": Boolean expected`,
      };
    }
    return parsed ? 'on' : 'off';
  }

  asInt(name: string, defaultValue = 0): number | { error: string } {
    const value = this.values.get(name);
    if (value === undefined) return defaultValue;

    const parsed = parseInt32(value);
    if (parsed === null) {
      return {
        error: `invalid value "${value}" for "${name}": integer expected`,
      };
    }
    return parsed;
  }
}

/** Factory mirroring the upstream `CreateVariableSpace()` entry point. */
export const createVarStore = (): VarStore => new VarStore();
