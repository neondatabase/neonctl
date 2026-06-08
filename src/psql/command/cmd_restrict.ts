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
 *  - The restriction state lives in `settings.restrictedKey`, NOT in the
 *    user-writable `vars` store. An earlier design kept it in a psql
 *    variable named `RESTRICTED`, which let `\set RESTRICTED ''` (or
 *    `\unset` / `\getenv` / `\gset` of that name) silently leave restricted
 *    mode without knowing the `\restrict` key — fully defeating the control
 *    (review item #12). Only `\restrict` / `\unrestrict` touch the field.
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

/** Standard refusal message emitted when a gated command is invoked while
 * the session is in restricted mode. Public so callers and tests can match
 * against the exact string. */
export const RESTRICTED_REFUSAL_MESSAGE = (cmdName: string): string =>
  `\\${cmdName}: command is not allowed in restricted mode; ` +
  `use \\unrestrict to leave restricted mode\n`;

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
  // `\o`/`\g`/`\gx` route through openWriter(), which spawns `sh -c <cmd>`
  // for a `|command` target (arbitrary shell exec) and writes the filesystem
  // for a FILE target; `\s FILE` writes history to disk. Block them by name
  // (review item #13). Plain query execution still works via `;`.
  'o', // \o [FILE | |cmd]
  'g', // \g [FILE | |cmd]
  'gx', // \gx [FILE | |cmd]
  's', // \s [FILE] — write command history
]);

/**
 * True iff the session is currently in restricted mode. Reads the
 * protected {@link PsqlSettings.restrictedKey} field (NOT a psql var, so
 * `\set`/`\unset`/`\getenv`/`\gset` cannot flip it — review item #12).
 */
export const isRestricted = (settings: PsqlSettings): boolean =>
  settings.restrictedKey !== null;

/**
 * Return the active restriction name (the value supplied to
 * `\restrict NAME`), or `null` if not restricted.
 */
export const restrictedName = (settings: PsqlSettings): string | null =>
  settings.restrictedKey;

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
    ctx.settings.restrictedKey = arg;
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
    ctx.settings.restrictedKey = null;
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

/**
 * Wrap every already-registered spec whose primary name is in
 * {@link RESTRICTED_COMMANDS} so its `run` gates on the live restriction
 * state. Without this the gate in `dispatch.ts::dispatchBackslash` only
 * fires for the `psqlrc` path; the REPL mainloop currently invokes
 * `spec.run` directly and would bypass the check.
 *
 * Idempotent: a wrapped spec carries a `[WRAPPED_FLAG]` marker so a second
 * call is a no-op. Must be called *after* all restricted commands have
 * been registered (so we see them via `registry.lookup`).
 */
const WRAPPED_FLAG = Symbol.for('neonctl.psql.restrictWrapped');

type WrappedSpec = BackslashCmdSpec & { [WRAPPED_FLAG]?: true };

export const wrapRestrictedCommands = (registry: BackslashRegistry): void => {
  for (const name of RESTRICTED_COMMANDS) {
    const spec = registry.lookup(name) as WrappedSpec | undefined;
    if (!spec || spec[WRAPPED_FLAG]) continue;
    const originalRun = spec.run.bind(spec);
    const gated: WrappedSpec = {
      ...spec,
      run: (ctx: BackslashContext): Promise<BackslashResult> => {
        if (isRestricted(ctx.settings)) {
          writeErr(RESTRICTED_REFUSAL_MESSAGE(ctx.cmdName));
          return Promise.resolve({ status: 'error' });
        }
        return originalRun(ctx);
      },
    };
    gated[WRAPPED_FLAG] = true;
    registry.register(gated);
  }
};
