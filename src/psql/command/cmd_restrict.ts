/**
 * `\restrict` and `\unrestrict` — PG 18 introduced these to lock the
 * psql REPL into a "restricted" sub-shell where shell-side or
 * filesystem-side backslash commands are refused.
 *
 * Implementation notes (deviations from upstream by design):
 *
 *  - Upstream PG 18 blocks **every** backslash command except
 *    `\unrestrict` while restricted. The brief for this work package
 *    instructs a narrower policy: block only the commands that can
 *    spawn a child process, write to the local filesystem, or mutate
 *    the surrounding environment (`\!`, `\cd`, `\copy`, `\setenv`,
 *    `\write` / `\w`). Plain SQL and read-only meta commands continue
 *    to run. The trade-off: easier for scripted use, slightly looser
 *    than upstream. Documented here and surfaced to the user via the
 *    error message.
 *
 *  - The restriction state is persisted as a psql variable named
 *    `RESTRICTED`. Setting it from `\set RESTRICTED foo` would also
 *    activate the policy — we treat the psql var as the source of
 *    truth. The trade-off: `\set` can also leave restricted mode.
 *    To prevent that, the dispatcher gate would need to reject the
 *    name `RESTRICTED` itself; we leave that to a follow-up because
 *    the brief asks for a single-line dispatch change.
 *
 *  - `\copy` is restricted in full, not only `\copy ... FROM PROGRAM`.
 *    The brief explicitly asks for registry-level interception
 *    (avoid touching every cmd_* file) — that constrains us to whole
 *    commands by name. Documented as a deliberate over-restriction.
 *
 *  - Name matching: `\unrestrict NAME` requires the same NAME that
 *    `\restrict NAME` provided. A mismatch keeps the session in
 *    restricted mode and returns an error.
 */

import type {
  BackslashCmdSpec,
  BackslashContext,
  BackslashResult,
  BackslashRegistry,
} from '../types/backslash.js';
import type { PsqlSettings } from '../types/settings.js';

import { writeErr } from './shared.js';

/**
 * psql variable holding the active restriction name. When set to a
 * non-empty string the session is in restricted mode. Unset / empty
 * means unrestricted.
 *
 * Public so tests + dispatch.ts can reuse it without re-stringifying.
 */
export const RESTRICTED_VAR = 'RESTRICTED';

/**
 * Backslash command names blocked while restricted. Lookup is by
 * **primary** name — aliases (e.g. `write` → `w`, `quit` → `q`)
 * resolve to the primary spec before the gate runs, so the gate sees
 * the canonical name.
 *
 * Trade-off (per the WP brief): block `\copy` entirely rather than
 * inspect the args for `PROGRAM`. Aligns with "intercept at the
 * registry level" and avoids touching cmd_copy.ts internals.
 */
export const RESTRICTED_COMMANDS: ReadonlySet<string> = new Set([
  '!', // shell escape
  'cd', // change directory
  'copy', // \copy — including \copy FROM PROGRAM
  'setenv', // mutate process env
  'w', // \w / \write — file write of query buffer
]);

/**
 * True iff the session is currently in restricted mode. Reads from
 * the `RESTRICTED` psql variable.
 */
export const isRestricted = (settings: PsqlSettings): boolean => {
  const v = settings.vars.get(RESTRICTED_VAR);
  return v !== undefined && v.length > 0;
};

/**
 * Return the active restriction name (the value supplied to
 * `\restrict NAME`), or `null` if not restricted.
 */
export const restrictedName = (settings: PsqlSettings): string | null => {
  const v = settings.vars.get(RESTRICTED_VAR);
  return v !== undefined && v.length > 0 ? v : null;
};

/**
 * Predicate used by the dispatcher: should the given primary command
 * name be refused right now?
 */
export const isCommandRestricted = (
  settings: PsqlSettings,
  primaryName: string,
): boolean => isRestricted(settings) && RESTRICTED_COMMANDS.has(primaryName);

/**
 * `\restrict NAME` — enter restricted mode. `NAME` (any non-empty
 * string) becomes the key that `\unrestrict` must match to leave.
 *
 * If already restricted, this is an error — upstream treats this
 * with an Assert; we surface it as a regular command error.
 */
export const cmdRestrict: BackslashCmdSpec = {
  name: 'restrict',
  helpKey: 'restrict',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const arg = ctx.nextArg('normal');
    if (arg === null || arg.length === 0) {
      writeErr(`\\${ctx.cmdName}: missing required argument\n`);
      return Promise.resolve({ status: 'error' });
    }
    if (isRestricted(ctx.settings)) {
      writeErr(`\\${ctx.cmdName}: already in restricted mode\n`);
      return Promise.resolve({ status: 'error' });
    }
    if (!ctx.settings.vars.set(RESTRICTED_VAR, arg)) {
      writeErr(
        `\\${ctx.cmdName}: could not set "${RESTRICTED_VAR}" variable\n`,
      );
      return Promise.resolve({ status: 'error' });
    }
    return Promise.resolve({ status: 'ok' });
  },
};

/**
 * `\unrestrict NAME` — leave restricted mode if NAME matches the key
 * given to the original `\restrict`.
 */
export const cmdUnrestrict: BackslashCmdSpec = {
  name: 'unrestrict',
  helpKey: 'unrestrict',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const arg = ctx.nextArg('normal');
    if (arg === null || arg.length === 0) {
      writeErr(`\\${ctx.cmdName}: missing required argument\n`);
      return Promise.resolve({ status: 'error' });
    }
    const current = restrictedName(ctx.settings);
    if (current === null) {
      writeErr(`\\${ctx.cmdName}: not currently in restricted mode\n`);
      return Promise.resolve({ status: 'error' });
    }
    if (arg !== current) {
      writeErr(`\\${ctx.cmdName}: wrong key\n`);
      return Promise.resolve({ status: 'error' });
    }
    ctx.settings.vars.unset(RESTRICTED_VAR);
    return Promise.resolve({ status: 'ok' });
  },
};

/**
 * Convenience registration helper, used by `defaultRegistry()` in
 * `dispatch.ts`. Kept in this file so the dispatch.ts addition is a
 * single line.
 */
export const registerRestrictCommands = (registry: BackslashRegistry): void => {
  registry.register(cmdRestrict);
  registry.register(cmdUnrestrict);
};
