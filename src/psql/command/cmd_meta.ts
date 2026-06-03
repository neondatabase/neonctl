/**
 * Meta backslash commands.
 *
 * TypeScript port of the corresponding `exec_command_*` functions in
 * upstream PostgreSQL's `src/bin/psql/command.c`:
 *
 *   - `\q` / `\quit`              → exec_command_quit
 *   - `\r` / `\reset`             → exec_command_reset
 *   - `\!`                        → exec_command_shell_escape (do_shell)
 *   - `\cd`                       → exec_command_cd
 *   - `\echo`, `\qecho`, `\warn`  → exec_command_echo / qecho / warn
 *   - `\prompt`                   → exec_command_prompt
 *   - `\set`, `\unset`            → exec_command_set / exec_command_unset
 *   - `\getenv`, `\setenv`        → exec_command_getenv / exec_command_setenv
 *   - `\errverbose`               → exec_command_errverbose
 *   - `\timing`                   → exec_command_timing
 *   - `\copyright`                → exec_command_copyright
 *   - `\h` / `\help`              → exec_command_help (helpSQL)
 *
 * Each command is exported as a `BackslashCmdSpec` so {@link defaultRegistry}
 * in `dispatch.ts` can register them. Error messages follow upstream's
 * `\<cmd>: <message>` shape and go to stderr; on failure we return
 * `{ status: 'error' }`. Successful invocations return `{ status: 'ok' }`.
 *
 * Stubs / deferred behaviour:
 *
 *   - `\!` always returns `{ status: 'ok' }` — upstream does not propagate
 *     the child's exit status to the surrounding script, only the run-mode.
 *     Tests use a stdio mock; in interactive use the child inherits stdio.
 *   - `\prompt -` (no-echo password prompting) reads via the shared input
 *     layer with echo suppressed on a TTY (falling back to a plain read on
 *     non-interactive input).
 *   - `\qecho` writes to `settings.logfile` if set, else stdout. Upstream
 *     additionally honours a separate "query output" file set via `\o`;
 *     that wiring lives in WP-15 and we leave the hook in place.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readLine } from '../io/input.js';
import { getHistory } from '../io/history.js';
import { slashUsage } from '../core/help.js';

import type {
  BackslashCmdSpec,
  BackslashContext,
  BackslashResult,
} from '../types/backslash.js';
import type {
  LastErrorResult,
  PsqlSettings,
  ShowContext,
  VerbosityLevel,
} from '../types/settings.js';
import { helpSQL } from '../core/help.js';

import { writeOut, writeErr, parseBool } from './shared.js';

/** `\q` / `\quit` — exit the REPL. */
export const cmdQuit: BackslashCmdSpec = {
  name: 'q',
  aliases: ['quit'],
  helpKey: 'q',
  run: (): Promise<BackslashResult> => Promise.resolve({ status: 'exit' }),
};

/**
 * `\!` — shell escape. Whole-line mode: the entire rest of the line is the
 * command string.
 *
 *   - `\!` (no args)             → spawn `$SHELL -i` (fallback `sh -i`)
 *   - `\!command args`           → spawn `sh -c 'command args'`
 *
 * In both cases the child inherits stdio and we return `{ status: 'ok' }`
 * regardless of the child's exit status — matching upstream `do_shell`,
 * which keeps the REPL alive after a failing shell command rather than
 * propagating the exit code. Catching a spawn-time exception keeps us
 * resilient against environments where `sh` is unavailable.
 */
export const cmdShell: BackslashCmdSpec = {
  name: '!',
  argMode: 'whole-line',
  helpKey: '!',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const line = ctx.restOfLine().trim();
    try {
      if (line.length === 0) {
        const shell = process.env.SHELL ?? '/bin/sh';
        spawnSync(shell, ['-i'], { stdio: 'inherit' });
      } else {
        spawnSync('sh', ['-c', line], { stdio: 'inherit' });
      }
    } catch {
      // Upstream `do_shell` swallows shell-spawn failures: the REPL has to
      // keep running even when the child won't start. Status stays `ok` so
      // a failing `\!` is purely informational.
    }
    return Promise.resolve({ status: 'ok' });
  },
};

/** `\cd [dir]` — change cwd. No arg falls back to `$HOME`. */
export const cmdCd: BackslashCmdSpec = {
  name: 'cd',
  helpKey: 'cd',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const dir = ctx.nextArg('normal');
    const target = dir && dir.length > 0 ? dir : (process.env.HOME ?? null);
    if (!target) {
      writeErr(`\\${ctx.cmdName}: could not determine home directory\n`);
      return Promise.resolve({ status: 'error' });
    }
    try {
      process.chdir(target);
      return Promise.resolve({ status: 'ok' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeErr(`\\${ctx.cmdName}: ${msg}\n`);
      return Promise.resolve({ status: 'error' });
    }
  },
};

/**
 * Helper for `\echo` / `\qecho` / `\warn`. Reads args until exhausted,
 * honours the leading `-n` flag (suppresses trailing newline), joins with
 * single spaces, and writes to the chosen stream.
 *
 * Upstream `exec_command_echo` only treats `-n` as a flag when the source
 * was the unquoted two-character token `-n`. `'-n'` (single-quoted) is a
 * literal value: it should be printed AND the trailing newline kept. We
 * inspect `ctx.rawArgs` directly because `nextArg` discards quote
 * metadata after lexing.
 */
const runEcho = (
  ctx: BackslashContext,
  write: (s: string) => void,
): BackslashResult => {
  const parts: string[] = [];
  let noNewline = false;
  let first = true;
  // Pre-scan the raw text to decide whether the first arg was the
  // unquoted `-n` token. We can't rely on the lexed arg value alone:
  // `'-n'` / `"-n"` produce the same string but must be treated as data.
  const firstArgIsUnquotedDashN = ((): boolean => {
    let i = 0;
    while (i < ctx.rawArgs.length && /\s/.test(ctx.rawArgs[i])) i++;
    return (
      ctx.rawArgs.slice(i, i + 2) === '-n' &&
      (i + 2 === ctx.rawArgs.length || /\s/.test(ctx.rawArgs[i + 2]))
    );
  })();
  for (;;) {
    const arg = ctx.nextArg('normal');
    if (arg === null) break;
    if (first && firstArgIsUnquotedDashN && arg === '-n') {
      noNewline = true;
      first = false;
      continue;
    }
    first = false;
    parts.push(arg);
  }
  const out = parts.join(' ') + (noNewline ? '' : '\n');
  write(out);
  return { status: 'ok' };
};

/** `\echo` — write args to stdout. */
export const cmdEcho: BackslashCmdSpec = {
  name: 'echo',
  helpKey: 'echo',
  run: (ctx: BackslashContext): Promise<BackslashResult> =>
    Promise.resolve(runEcho(ctx, writeOut)),
};

/** `\qecho` — write args to the query output (logfile if set, else stdout). */
export const cmdQecho: BackslashCmdSpec = {
  name: 'qecho',
  helpKey: 'qecho',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const { logfile } = ctx.settings;
    const write = (s: string): void => {
      if (logfile) {
        logfile.write(s);
      } else {
        writeOut(s);
      }
    };
    return Promise.resolve(runEcho(ctx, write));
  },
};

/** `\warn` — write args to stderr. */
export const cmdWarn: BackslashCmdSpec = {
  name: 'warn',
  helpKey: 'warn',
  run: (ctx: BackslashContext): Promise<BackslashResult> =>
    Promise.resolve(runEcho(ctx, writeErr)),
};

/**
 * `\prompt [TEXT] varname`
 *
 * Upstream: read one line of input from the terminal, optionally with a
 * prompt prefix, and assign it to a psql variable. A leading `-` flag
 * requests a no-echo read (used for password prompts); we honour it by
 * reading through the shared input layer with echo suppressed on a TTY
 * (and a plain read otherwise — non-interactive input still consumes the
 * line, matching upstream).
 *
 * Args after the optional `-` flag are `[TEXT] varname`: if only one
 * remains it is the variable name and no prompt prefix is shown; if two,
 * the first is the prompt and the second the variable.
 */
export const cmdPrompt: BackslashCmdSpec = {
  name: 'prompt',
  helpKey: 'prompt',
  run: async (ctx: BackslashContext): Promise<BackslashResult> => {
    const args: string[] = [];
    for (;;) {
      const a = ctx.nextArg('normal');
      if (a === null) break;
      args.push(a);
    }

    // A leading `-` selects the no-echo (password) read path.
    let echo = true;
    if (args.length > 0 && args[0] === '-') {
      echo = false;
      args.shift();
    }

    if (args.length === 0) {
      writeErr(`\\${ctx.cmdName}: missing required argument\n`);
      return { status: 'error' };
    }

    let promptText = '';
    let varname: string;
    if (args.length === 1) {
      varname = args[0];
    } else {
      promptText = args[0];
      varname = args[1];
    }

    const line = await readLine(promptText, { echo });
    if (!ctx.settings.vars.set(varname, line)) {
      writeErr(`\\${ctx.cmdName}: invalid variable name "${varname}"\n`);
      return { status: 'error' };
    }
    return { status: 'ok' };
  },
};

/**
 * `\set [varname [value...]]`
 *
 * - No args → list all variables (sorted, `name = 'value'` per line) to
 *   stdout. Upstream uses single-quotes around the value.
 * - One arg → set the variable to the empty string.
 * - More args → join the rest with a single space and set the variable.
 *
 * Diagnostics mirror upstream `exec_command_set` in `src/bin/psql/command.c`:
 *
 *   - Names containing characters outside `[A-Za-z_][A-Za-z0-9_]*` produce
 *     `invalid variable name: "<name>"` (prefixed with `psql: `).
 *   - Per-variable hook rejections (AUTOCOMMIT / FETCH_COUNT /
 *     ON_ERROR_ROLLBACK / VERBOSITY / etc.) carry the hook's message
 *     verbatim; we add only the `psql: ` prefix.
 *   - Hook vetoes with no message fall back to a generic line. This
 *     should not happen in practice — every registered hook either
 *     accepts or returns a wording string.
 */
export const cmdSet: BackslashCmdSpec = {
  name: 'set',
  helpKey: 'set',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const name = ctx.nextArg('normal');
    if (name === null) {
      // List all vars sorted by name.
      const entries = [...ctx.settings.vars.entries()].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      for (const [k, v] of entries) {
        writeOut(`${k} = '${v}'\n`);
      }
      return Promise.resolve({ status: 'ok' });
    }

    const values: string[] = [];
    for (;;) {
      const a = ctx.nextArg('normal');
      if (a === null) break;
      values.push(a);
    }
    const value = values.join('');
    const result = ctx.settings.vars.trySet(name, value);
    if (!result.ok) {
      const prefix = psqlErrorPrefix(ctx.settings);
      if (result.reason === 'invalid-name') {
        writeErr(`${prefix}invalid variable name: "${name}"\n`);
      } else if (result.error !== undefined) {
        // Hook supplied its own wording — emit verbatim, prefixed with
        // `psql: `. The message intentionally does NOT carry a severity
        // (`error:` / `ERROR:`) because upstream's per-variable hooks
        // also emit just `psql: <msg>` (see `bool_substitute_hook` etc.).
        writeErr(`${prefix}${result.error}\n`);
      } else {
        // Hook returned `false` without a message — fall back to a
        // generic line so callers still see something. None of the
        // built-in hooks take this path, but third-party callers might.
        writeErr(`${prefix}error while setting variable "${name}"\n`);
      }
      return Promise.resolve({ status: 'error' });
    }
    return Promise.resolve({ status: 'ok' });
  },
};

/**
 * `\r` / `\reset` — discard the accumulated query buffer.
 *
 * Mirrors upstream `exec_command_reset`:
 *
 *   resetPQExpBuffer(query_buf);
 *   psql_scan_reset(scan_state);
 *   if (!pset.quiet)
 *     puts(_("Query buffer reset (cleared)."));
 *
 * We model the buffer + scanner reset via `status: 'reset-buf'`; the
 * mainloop wipes `queryBuf` and re-initialises `scanState` when it sees
 * this. The diagnostic is gated on the `quiet` setting so `psql -q` (and
 * the regress harness, which passes `--quiet`) produces no output.
 */
export const cmdReset: BackslashCmdSpec = {
  name: 'r',
  aliases: ['reset'],
  helpKey: 'r',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    if (!ctx.settings.quiet) {
      writeOut('Query buffer reset (cleared).\n');
    }
    return Promise.resolve({ status: 'reset-buf', newBuf: '' });
  },
};

/** `\unset varname` — unset a psql variable. */
export const cmdUnset: BackslashCmdSpec = {
  name: 'unset',
  helpKey: 'unset',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const name = ctx.nextArg('normal');
    if (name === null) {
      writeErr(`\\${ctx.cmdName}: missing required argument\n`);
      return Promise.resolve({ status: 'error' });
    }
    ctx.settings.vars.unset(name);
    return Promise.resolve({ status: 'ok' });
  },
};

export const cmdGetenv: BackslashCmdSpec = {
  name: 'getenv',
  helpKey: 'getenv',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const varname = ctx.nextArg('normal');
    const envname = ctx.nextArg('normal');
    if (varname === null || envname === null) {
      writeErr(`\\${ctx.cmdName}: missing required argument\n`);
      return Promise.resolve({ status: 'error' });
    }
    const value = process.env[envname];
    if (value === undefined) {
      return Promise.resolve({ status: 'ok' });
    }
    if (!ctx.settings.vars.set(varname, value)) {
      writeErr(`\\${ctx.cmdName}: invalid variable name "${varname}"\n`);
      return Promise.resolve({ status: 'error' });
    }
    return Promise.resolve({ status: 'ok' });
  },
};

/**
 * `\setenv envvar [value]`
 *
 * Set `process.env[envvar] = value`; with no value, delete it. Upstream
 * rejects names containing `=`.
 */
export const cmdSetenv: BackslashCmdSpec = {
  name: 'setenv',
  helpKey: 'setenv',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const envname = ctx.nextArg('normal');
    if (envname === null) {
      writeErr(`\\${ctx.cmdName}: missing required argument\n`);
      return Promise.resolve({ status: 'error' });
    }
    if (envname.includes('=')) {
      writeErr(
        `\\${ctx.cmdName}: environment variable name must not contain "="\n`,
      );
      return Promise.resolve({ status: 'error' });
    }
    // Upstream `exec_command_setenv` reads BOTH the name AND the value with
    // OT_NORMAL — `:VAR` substitution applies to the value so
    // `\setenv FOO :BAR` propagates the psql-variable value into the env.
    // (Earlier 'no-vars' was a misread; vanilla psql expands inside the
    // value.) The mainloop context maintains a per-mode cursor, so using
    // a single mode for both calls also keeps positional reads in sync —
    // each cursor advances exactly once per call.
    const value = ctx.nextArg('normal');
    if (value === null) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete process.env[envname];
    } else {
      process.env[envname] = value;
    }
    return Promise.resolve({ status: 'ok' });
  },
};

/**
 * Build the `psql:` diagnostic prefix that upstream `pg_log_pre_callback`
 * prepends to error lines, but ONLY when reading from a script file. Mirrors:
 *
 *   if (cur_cmd_source == QUERY_FROM_FILE)
 *       fprintf(stderr, "psql:%s:%d: ", cur_cmd_filename, cur_cmd_lineno);
 *
 *   - `curCmdSource === 'file'` (running under `-f FILE`, `\i FILE`,
 *     `\ir FILE`, or `.psqlrc`): `psql:<inputfile>:<lineno>: `.
 *   - Stdin pipe, `-c "..."`, interactive REPL: empty string — vanilla
 *     `psql --no-psqlrc -X` reading SQL from stdin emits NO prefix on
 *     either `\set` validation errors or server `ERROR:` lines.
 *
 * Returned string ends in a trailing space when non-empty so callers can
 * concatenate the severity directly (`prefix + 'ERROR:  msg'`).
 */
export const psqlErrorPrefix = (
  settings: PsqlSettings,
  lineNumber?: number,
): string => {
  if (settings.curCmdSource === 'file' && settings.inputfile) {
    const lineSuffix = lineNumber !== undefined ? String(lineNumber) : '';
    return `psql:${settings.inputfile}:${lineSuffix}: `;
  }
  return '';
};

/**
 * Walk past leading whitespace + `--` line comments + slash-star block
 * comments at the head of `sqlText`. Returns the byte index of the first
 * "real" content character. Used by `renderLineAndCaret` to align the
 * `LINE N:` counter with upstream psql — vanilla strips these from the
 * buffer before `PQexec` (so the server's `position` is relative to the
 * trimmed buffer), but `captureLastError`/`normaliseSqlAndPosition` only
 * strips whitespace. Re-stripping here closes the gap when the captured
 * `sqlText` still carries leading `-- comment` lines (the common case
 * for SQL that the mainloop dispatched directly via `sendQuery`,
 * because that path doesn't pre-trim comments).
 *
 * Idempotent for already-trimmed input: if `sqlText` has no leading
 * prelude we return `0`, the caller takes the existing fast-path, and
 * the LINE count remains the count of newlines strictly before
 * `position - 1`.
 */
const skipLeadingPrelude = (sqlText: string): number => {
  let i = 0;
  const n = sqlText.length;
  while (i < n) {
    const c = sqlText.charCodeAt(i);
    if (
      c === 0x20 ||
      c === 0x09 ||
      c === 0x0a ||
      c === 0x0d ||
      c === 0x0c ||
      c === 0x0b
    ) {
      i++;
      continue;
    }
    if (c === 0x2d && sqlText.charCodeAt(i + 1) === 0x2d) {
      i += 2;
      while (i < n && sqlText.charCodeAt(i) !== 0x0a) i++;
      continue;
    }
    if (c === 0x2f && sqlText.charCodeAt(i + 1) === 0x2a) {
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (
          sqlText.charCodeAt(i) === 0x2f &&
          sqlText.charCodeAt(i + 1) === 0x2a
        ) {
          depth++;
          i += 2;
        } else if (
          sqlText.charCodeAt(i) === 0x2a &&
          sqlText.charCodeAt(i + 1) === 0x2f
        ) {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    break;
  }
  return i;
};

/**
 * Render the `LINE N: …` re-print plus the `^` pointer underneath the
 * failing character, mirroring upstream psql's `report_error_query`
 * helper. Returns `null` when we don't have enough context (no SQL text
 * or no position) so the caller can skip the lines entirely.
 *
 * `position` is a 1-based character offset into `sqlText` (as delivered
 * in the server's `P` field). We pick the LINE containing that offset
 * and emit:
 *
 *     LINE N: <that line>
 *             ^
 *
 * The caret column is aligned to the offset within the picked line so
 * it points at the failing token. Trailing newlines on the picked line
 * are stripped so the `$` end-anchor in upstream's regex still matches.
 *
 * Leading whitespace + comments are skipped before computing the LINE
 * number so the count starts at the first content line — vanilla
 * advances past these before `PQexec`, so the server's `position` is
 * 1-based relative to a trimmed buffer; without the same skip here we'd
 * count newlines that vanilla never sent.
 *
 * Trailing-whitespace fix-up: callers in `cmd_io.ts` strip a `\g`-style
 * buffer's trailing whitespace before handing the SQL to `db.execSimple`
 * / `db.query`, so the server's `position` is relative to the trimmed
 * SQL while `sqlText` (used for the LINE echo) still carries the
 * trailing space(s). When `position` lands on trailing whitespace of
 * the LINE we picked — i.e., past `lineText.trimEnd().length` — that's
 * the "syntax error at end of input" case: vanilla sends the trailing
 * whitespace verbatim and the server reports a position one past the
 * full LINE length. Snap the caret to the end of `lineText` so our
 * output matches vanilla's `^` column. PostgreSQL's scanner never
 * emits positions pointing AT whitespace tokens (they're not lexed as
 * tokens), so the only realistic source of an "in trailing
 * whitespace" position is this trim-on-send delta.
 *
 * Exported so the per-statement error renderer in `core/common.ts` can
 * share the helper with `\errverbose`.
 */
export const renderLineAndCaret = (
  sqlText: string | undefined,
  position: string | undefined,
): { line: string; caret: string } | null => {
  if (!sqlText || !position) return null;
  const pos = parseInt(position, 10);
  if (!Number.isFinite(pos) || pos <= 0) return null;
  // Advance past leading WS + comments so the LINE count starts at the
  // first content line. The server's position is into the on-the-wire
  // bytes — typically already past these, so rebasing keeps it inside
  // the content range; if the rebased position would underflow we drop
  // the LINE/caret block rather than mis-pointing.
  const skip = skipLeadingPrelude(sqlText);
  const trimmed = skip === 0 ? sqlText : sqlText.slice(skip);
  const rebasedPos = pos - skip;
  if (rebasedPos <= 0) return null;
  // The server's offset is 1-based and points at the failing character.
  const idx = Math.min(rebasedPos - 1, trimmed.length);
  // Find the line containing `idx`.
  let lineStart = trimmed.lastIndexOf('\n', idx - 1);
  lineStart = lineStart === -1 ? 0 : lineStart + 1;
  let lineEnd = trimmed.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = trimmed.length;
  const lineText = trimmed.slice(lineStart, lineEnd);
  // Line number for the `LINE N:` prefix — 1-based.
  const before = trimmed.slice(0, lineStart);
  const lineNumber = (before.match(/\n/gu)?.length ?? 0) + 1;
  // Column inside the picked line (0-based) where the `^` goes. Tabs
  // upstream are expanded to a fixed width; we approximate with a
  // single space so the pointer at least lands in the right ballpark.
  let col = idx - lineStart;
  // Snap past trailing whitespace when the position lands inside it —
  // see the function header for the rationale (trim-on-send delta).
  const lineTrimEndLen = lineText.replace(/[ \t\f\v]+$/u, '').length;
  if (col >= lineTrimEndLen && col < lineText.length) {
    col = lineText.length;
  }
  const caretIndent = ' '.repeat(Math.max(0, col));
  const prefix = `LINE ${String(lineNumber)}: `;
  return {
    line: `${prefix}${lineText}`,
    caret: `${' '.repeat(prefix.length)}${caretIndent}^`,
  };
};

/**
 * Render an ErrorResponse-shaped payload as the layered, verbosity-aware
 * report that upstream psql emits to stderr after a failed statement
 * (`PSQLExec` / `ProcessResult` in `src/bin/psql/common.c`).
 *
 * Returned array contains one element per logical line, without trailing
 * newlines — callers join with `\n` and write to their stream.
 *
 * Verbosity / SHOW_CONTEXT semantics, mirrored from upstream:
 *
 *   - `terse`: only the severity line (`<sev>:  <msg>`) is emitted.
 *
 *   - `default`: severity + message, plus `LINE N` / caret, DETAIL, HINT,
 *     STATEMENT (we omit STATEMENT — we never echo the query verbatim).
 *     CONTEXT and LOCATION are suppressed unless `SHOW_CONTEXT='always'`.
 *
 *   - `verbose`: adds the SQLSTATE prefix on the severity line, and
 *     CONTEXT plus LOCATION are unconditionally included when present.
 *
 *   - `sqlstate`: prepend the SQLSTATE on the severity line (same as
 *     `verbose`'s first line), but suppress LINE/DETAIL/HINT/CONTEXT/
 *     LOCATION. Matches the upstream "just give me the code" flavour.
 *
 * Empty server fields are skipped silently. The `LINE` / `^` pair only
 * appears when we have both originating SQL text and a 1-based position
 * pointing inside it.
 */
export const formatErrorReport = (
  e: LastErrorResult,
  verbosity: VerbosityLevel = 'default',
  showContext: ShowContext = 'errors',
): string[] => {
  const severity = e.severity ?? 'ERROR';
  const sqlstate = e.code ?? e.sqlstate ?? 'XX000';
  const message = e.message ?? '';
  const out: string[] = [];

  // `sqlstate` mode is the upstream "just give me the code" flavour:
  // emit `<severity>:  <sqlstate>` with NO message body. `verbose` mode
  // adds the SQLSTATE prefix and keeps the message + LINE/DETAIL/HINT
  // layers below. Default/terse omit the SQLSTATE entirely.
  //
  // Reference: upstream `pg_log_pre_callback` / `PQresultErrorMessage`
  // with `verbosity = PQERRORS_SQLSTATE`, which formats just
  // `severity: sqlstate\n` and stops.
  if (verbosity === 'sqlstate') {
    out.push(`${severity}:  ${sqlstate}`);
    return out;
  }
  if (verbosity === 'verbose') {
    out.push(`${severity}:  ${sqlstate}: ${message}`);
  } else if (verbosity === 'terse') {
    // Terse suppresses LINE/caret/DETAIL/HINT/CONTEXT, but it merges the
    // server's `position` into the severity line as `at character N` —
    // matches libpq's `pqGetErrorNotice3` with `PQERRORS_TERSE` (and
    // vanilla psql in the regress fixture). Only fires when position is a
    // positive integer; the LINE/caret block below would have shown the
    // same anchor for default verbosity.
    const pos = e.position ? Number.parseInt(e.position, 10) : NaN;
    if (Number.isFinite(pos) && pos > 0) {
      out.push(`${severity}:  ${message} at character ${String(pos)}`);
    } else {
      out.push(`${severity}:  ${message}`);
    }
    return out;
  } else {
    out.push(`${severity}:  ${message}`);
  }

  const lineCaret = renderLineAndCaret(e.sqlText, e.position);
  if (lineCaret) {
    out.push(lineCaret.line);
    out.push(lineCaret.caret);
  }
  if (e.detail) out.push(`DETAIL:  ${e.detail}`);
  if (e.hint) out.push(`HINT:  ${e.hint}`);
  // CONTEXT under default verbosity follows SHOW_CONTEXT: 'never' / 'errors'
  // (the default — show on errors) / 'always'. We treat every call into the
  // formatter as an error report, so 'errors' and 'always' both include
  // CONTEXT, while 'never' suppresses it. Verbose verbosity unconditionally
  // includes CONTEXT.
  const includeContext = verbosity === 'verbose' || showContext !== 'never';
  if (includeContext && e.where) {
    out.push(`CONTEXT:  ${e.where}`);
  }
  if (verbosity === 'verbose' && (e.routine || e.file || e.line)) {
    const location =
      (e.routine ?? '') + (e.file ? `, ${e.file}:${e.line ?? ''}` : '');
    out.push(`LOCATION:  ${location}`);
  }
  return out;
};

/**
 * `\errverbose` — print the last error in verbose form. We rely on the
 * mainloop to have stored `settings.lastErrorResult`; this command only
 * formats and prints. Without a saved error, upstream emits "There is no
 * previous error."
 *
 * Verbose output (PG 18 form):
 *
 *     ERROR:  <sqlstate>: <message>
 *     LINE N: <originating line of SQL>
 *             ^
 *     DETAIL:  <detail>
 *     HINT:  <hint>
 *     CONTEXT:  <where>
 *     LOCATION:  <routine>, <file>:<line>
 *
 * Empty fields are omitted. The `LINE` / `^` pair is only emitted when
 * we have both the originating SQL text and a server-provided position.
 */
export const cmdErrverbose: BackslashCmdSpec = {
  name: 'errverbose',
  helpKey: 'errverbose',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const e = ctx.settings.lastErrorResult;
    if (!e || (!e.message && !e.sqlstate && !e.code)) {
      // Upstream `exec_command_errverbose` writes the "no previous error"
      // notice to stdout (via `printf`); only the verbose re-render goes to
      // stderr (via `pg_log_error`).
      writeOut('There is no previous error.\n');
      return Promise.resolve({ status: 'ok' });
    }
    // `\errverbose` always emits the full verbose form regardless of the
    // currently active VERBOSITY setting. Output is prefixed with the same
    // `psql:[<file>:<n>]:` tag upstream's `pg_log_pre_callback` adds — only
    // on the leading severity line; subsequent layers (LINE / caret / DETAIL
    // / HINT / LOCATION) stay unprefixed to match libpq's `PQresultErrorMessage`.
    const lines = formatErrorReport(e, 'verbose', 'always');
    const prefix = psqlErrorPrefix(ctx.settings);
    const prefixed = [prefix + lines[0], ...lines.slice(1)];
    writeErr(prefixed.join('\n') + '\n');
    return Promise.resolve({ status: 'ok' });
  },
};

/**
 * `\timing [on|off]` — set `settings.timing`. With no arg the value is
 * flipped. Prints the new state to stdout. `toggle` is NOT a valid value —
 * upstream errors "Boolean expected" (review: minor divergences).
 */
export const cmdTiming: BackslashCmdSpec = {
  name: 'timing',
  helpKey: 'timing',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const arg = ctx.nextArg('normal');
    let next: boolean;
    if (arg === null) {
      next = !ctx.settings.timing;
    } else {
      const parsed = parseBool(arg);
      if (parsed === null) {
        writeErr(
          `\\${ctx.cmdName}: unrecognized value "${arg}" for "\\timing": Boolean expected\n`,
        );
        return Promise.resolve({ status: 'error' });
      }
      next = parsed;
    }
    ctx.settings.timing = next;
    writeOut(`Timing is ${next ? 'on' : 'off'}.\n`);
    return Promise.resolve({ status: 'ok' });
  },
};

/**
 * Static text emitted by `\copyright`. Mirrors upstream psql's
 * `exec_command_copyright()` literal in `src/bin/psql/command.c`.
 */
const COPYRIGHT_TEXT = `PostgreSQL Database Management System
(formerly known as Postgres, then as Postgres95)

Portions Copyright (c) 1996-2024, PostgreSQL Global Development Group

Portions Copyright (c) 1994, The Regents of the University of California

Permission to use, copy, modify, and distribute this software and its
documentation for any purpose, without fee, and without a written agreement
is hereby granted, provided that the above copyright notice and this
paragraph and the following two paragraphs appear in all copies.

IN NO EVENT SHALL THE UNIVERSITY OF CALIFORNIA BE LIABLE TO ANY PARTY FOR
DIRECT, INDIRECT, SPECIAL, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, INCLUDING
LOST PROFITS, ARISING OUT OF THE USE OF THIS SOFTWARE AND ITS DOCUMENTATION,
EVEN IF THE UNIVERSITY OF CALIFORNIA HAS BEEN ADVISED OF THE POSSIBILITY OF
SUCH DAMAGE.

THE UNIVERSITY OF CALIFORNIA SPECIFICALLY DISCLAIMS ANY WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS FOR A PARTICULAR PURPOSE.  THE SOFTWARE PROVIDED HEREUNDER IS
ON AN "AS IS" BASIS, AND THE UNIVERSITY OF CALIFORNIA HAS NO OBLIGATIONS TO
PROVIDE MAINTENANCE, SUPPORT, UPDATES, ENHANCEMENTS, OR MODIFICATIONS.
`;

/**
 * neonctl-specific notice appended after the upstream PostgreSQL block.
 * This psql is a pure-TypeScript reimplementation embedded in neonctl, not
 * upstream psql — so we attribute it accordingly. No license claim is made
 * here on purpose (see the project's LICENSE file for terms).
 */
const NEON_NOTICE = `
This is an embedded psql reimplementation that ships with neonctl, the
command-line interface for Neon (https://neon.tech). Neon is part of
Databricks (https://www.databricks.com).

It is an independent reimplementation of psql and is not affiliated with
or endorsed by the PostgreSQL Global Development Group. See the neonctl
LICENSE file for distribution terms.
`;

/**
 * `\copyright` — print the PostgreSQL copyright / license notice, followed
 * by a neonctl + Neon/Databricks attribution block. Takes no arguments.
 * The upstream block is preserved verbatim so the conformance regex
 * `/Copyright/` (from upstream `001_basic.pl` line 75) is satisfied; the
 * Neon notice is appended after it.
 */
export const cmdCopyright: BackslashCmdSpec = {
  name: 'copyright',
  helpKey: 'copyright',
  run: (): Promise<BackslashResult> => {
    writeOut(COPYRIGHT_TEXT + NEON_NOTICE);
    return Promise.resolve({ status: 'ok' });
  },
};

/**
 * Terminal width used to lay out `\h` / `\help` topic lists. Upstream
 * uses `pset.popt.topt.envColumns` falling back to `ioctl(TIOCGWINSZ)`;
 * we read `process.stdout.columns` (Node populates this for TTYs) and
 * default to 80 if absent (non-TTY, piped output, etc.).
 */
const screenWidth = (): number => {
  const cols = process.stdout.columns;
  return typeof cols === 'number' && cols > 0 ? cols : 80;
};

/**
 * `\h [TOPIC]` (alias `\help`) — show SQL command help.
 *
 * Delegates to {@link helpSQL} in `core/help.ts`, passing the remainder
 * of the line as the topic. With no topic, prints the "Available help:"
 * overview; with a topic, prints the matching synopsis or a list of
 * matches. Mirrors upstream `exec_command_help` in `command.c`.
 */
export const cmdHelpSQL: BackslashCmdSpec = {
  name: 'h',
  aliases: ['help'],
  helpKey: 'h',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    // Upstream consumes the rest of the line in `OT_WHOLE_LINE` mode so
    // multi-word topics like "CREATE TABLE" come through intact.
    const topic = ctx.restOfLine();
    helpSQL(process.stdout, topic.length === 0 ? null : topic, screenWidth());
    return Promise.resolve({ status: 'ok' });
  },
};

/**
 * `\?` — show help for the backslash commands.
 *
 * Delegates to {@link slashUsage} in `core/help.ts`. We pass the output
 * stream (`process.stdout`) and request the pager only when that stream is
 * an interactive TTY — `slashUsage`/`emitHelp` re-check interactivity, but
 * gating the request here keeps the non-interactive path (scripts, piped
 * output, the regress harness) writing straight to stdout with no pager.
 *
 * Upstream `exec_command_help` reads `[commands|options|variables]`; we
 * mirror the default (backslash commands) form, which is the only variant
 * `\?` reaches without an argument. The remainder of the line is consumed
 * so a stray topic doesn't leak into the next command.
 */
export const cmdSlashHelp: BackslashCmdSpec = {
  name: '?',
  argMode: 'whole-line',
  helpKey: '?',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    // Consume the rest of the line (`\? options`, `\? variables`) so the
    // cursor doesn't strand trailing text; we only render the command help.
    ctx.restOfLine();
    const out = process.stdout;
    const pager = Boolean((out as NodeJS.WriteStream).isTTY);
    slashUsage(out, pager);
    return Promise.resolve({ status: 'ok' });
  },
};

/**
 * Resolve the editor command psql would launch for `\e` / `\ef` / `\ev`,
 * mirroring upstream `editFile` / `get_alternate_expansion`:
 *
 *   $PSQL_EDITOR  ||  $EDITOR  ||  $VISUAL  ||  platform default
 *
 * The platform default is `notepad.exe` on Windows and `vi` elsewhere,
 * matching upstream's `DEFAULT_EDITOR`.
 */
export const resolveEditor = (
  env: Record<string, string | undefined> = process.env,
): string => {
  const explicit = env.PSQL_EDITOR ?? env.EDITOR ?? env.VISUAL;
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return process.platform === 'win32' ? 'notepad.exe' : 'vi';
};

/**
 * `\e` / `\edit [FILE] [LINE]` — edit the current query buffer (or a file)
 * in the user's editor, then load the edited text back into the query
 * buffer.
 *
 * This port implements the common no-FILE form: dump the current query
 * buffer to a temp file, spawn the editor on it inheriting stdio (upstream
 * `do_edit` → `editFile`), and on a clean exit read the file back and
 * return it as the new query buffer via `status: 'reset-buf'`. Upstream
 * strips a single trailing newline the editor may add; we do the same so
 * round-tripping an unchanged buffer is a no-op.
 *
 * Editor selection follows {@link resolveEditor}. The spawn uses
 * `spawnSync(..., { stdio: 'inherit' })` so the editor owns the terminal.
 * If the editor exits non-zero (or fails to spawn) we leave the buffer
 * untouched and report an error, matching upstream's behaviour of not
 * importing a failed edit.
 *
 * FILE / LINE arguments are accepted but the buffer is still seeded from
 * the current query buffer; a future WP can layer file-backed editing
 * (`\e file`) and `\ef`/`\ev` on top.
 */
export const cmdEdit: BackslashCmdSpec = {
  name: 'e',
  aliases: ['edit'],
  argMode: 'whole-line',
  helpKey: 'e',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    // We don't yet support `\e FILE`; consume the args so they don't strand.
    ctx.restOfLine();

    const editor = resolveEditor();
    // psql seeds the temp file with the current query buffer. A trailing
    // newline keeps editors that expect newline-terminated files happy.
    const seed =
      ctx.queryBuf.length > 0 && !ctx.queryBuf.endsWith('\n')
        ? ctx.queryBuf + '\n'
        : ctx.queryBuf;

    let dir: string | null = null;
    try {
      dir = mkdtempSync(join(tmpdir(), 'psql.edit.'));
      const file = join(dir, 'edit.sql');
      writeFileSync(file, seed, 'utf8');

      const result = spawnSync(editor, [file], { stdio: 'inherit' });
      if (result.error || (result.status !== null && result.status !== 0)) {
        const why = result.error
          ? result.error.message
          : `editor exited with status ${String(result.status)}`;
        writeErr(`\\${ctx.cmdName}: ${why}\n`);
        return Promise.resolve({ status: 'error' });
      }

      let edited = readFileSync(file, 'utf8');
      // Upstream drops a single trailing newline the editor may have added
      // so an unchanged round-trip restores the original buffer exactly.
      if (edited.endsWith('\n')) edited = edited.slice(0, -1);
      return Promise.resolve({ status: 'reset-buf', newBuf: edited });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeErr(`\\${ctx.cmdName}: ${msg}\n`);
      return Promise.resolve({ status: 'error' });
    } finally {
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Temp-dir cleanup is best-effort; a leftover dir is harmless.
        }
      }
    }
  },
};

/**
 * `\s [FILENAME]` — print the command-line history, or save it to FILENAME.
 *
 * Mirrors upstream `exec_command_s` / `printHistory`:
 *
 *   - No argument: write the in-memory history (one entry per line) to
 *     stdout. Multi-line entries are printed verbatim (with their embedded
 *     newlines), matching readline's `\s` dump.
 *   - FILENAME given: write the same dump to that file. On success, and
 *     unless `\set QUIET` is in effect, print `Wrote history to file
 *     "<file>".` to stdout. On failure, emit the OS error to stderr and
 *     return an error.
 *
 * The history source is {@link getHistory}, the session's in-memory list
 * populated as each line is submitted (see `io/history.ts`).
 */
export const cmdS: BackslashCmdSpec = {
  name: 's',
  helpKey: 's',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const fname = ctx.nextArg('normal');
    const entries = getHistory();
    // Each entry is one logical command; readline's `\s` prints them one
    // per line, so a trailing newline per entry reproduces that layout.
    const body = entries.map((e) => e + '\n').join('');

    if (fname === null || fname.length === 0) {
      writeOut(body);
      return Promise.resolve({ status: 'ok' });
    }

    try {
      writeFileSync(fname, body, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeErr(`\\${ctx.cmdName}: ${msg}\n`);
      return Promise.resolve({ status: 'error' });
    }
    if (!ctx.settings.quiet) {
      writeOut(`Wrote history to file "${fname}".\n`);
    }
    return Promise.resolve({ status: 'ok' });
  },
};
