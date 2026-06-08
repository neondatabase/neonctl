/**
 * Internal helpers shared by `cmd_meta.ts` and `cmd_format.ts`.
 *
 * Kept deliberately tiny: just stream writes and the boolean coercion
 * shared by `\timing`, `\t`, `\x`, and `\pset` toggles. The implementations
 * mirror the relevant pieces of upstream `command.c` (`ParseVariableBool`)
 * and `print.c` / `print_aligned*` without depending on either.
 *
 * Why a shared file: the WP spec asks for cmd-isolated test factories, not
 * for the command implementations themselves to duplicate one-line
 * primitives. Going through these helpers also keeps the eslint
 * `no-console` rule satisfied — every write touches `process.stdout` /
 * `process.stderr` directly rather than `console.log` / `console.error`.
 */

/** Write to stdout. */
export const writeOut = (s: string): void => {
  process.stdout.write(s);
};

/** Write to stderr. */
export const writeErr = (s: string): void => {
  process.stderr.write(s);
};

/**
 * Parse a psql boolean the way `ParseVariableBool` does — case-insensitive
 * unique-prefix match against `true|false|yes|no|on|off`, plus `1`/`0`.
 *
 * Returns `null` for unrecognised input.
 */
export const parseBool = (raw: string): boolean | null => {
  if (raw.length === 0) return null;
  const lower = raw.toLowerCase();
  const startsWith = (target: string): boolean =>
    lower.length <= target.length && target.startsWith(lower);
  if (startsWith('true')) return true;
  if (startsWith('false')) return false;
  if (startsWith('yes')) return true;
  if (startsWith('no')) return false;
  if (lower.length >= 2) {
    if ('on'.startsWith(lower)) return true;
    if ('off'.startsWith(lower)) return false;
  }
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
};

/**
 * Parse a psql tri-state value (`on` / `off` / `auto` / `toggle`). Returns
 * the resolved literal or `null` if unrecognised.
 */
export type Triple = 'on' | 'off' | 'auto' | 'toggle';
export const parseTriple = (raw: string): Triple | null => {
  const lower = raw.toLowerCase();
  if (lower.length === 0) return null;
  // Resolve booleans FIRST. Otherwise `t` matched the `toggle` prefix before
  // parseBool, so `\x t` toggled rather than turning expanded ON, and `\pset`
  // bool prefixes were inverted (review: minor divergences).
  const b = parseBool(raw);
  if (b === true) return 'on';
  if (b === false) return 'off';
  if ('auto'.startsWith(lower)) return 'auto';
  if ('toggle'.startsWith(lower)) return 'toggle';
  return null;
};
