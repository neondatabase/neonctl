/**
 * Meta backslash commands.
 *
 * TypeScript port of the corresponding `exec_command_*` functions in
 * upstream PostgreSQL's `src/bin/psql/command.c`:
 *
 *   - `\q` / `\quit`              → exec_command_quit
 *   - `\!`                        → exec_command_shell_escape (do_shell)
 *   - `\cd`                       → exec_command_cd
 *   - `\echo`, `\qecho`, `\warn`  → exec_command_echo / qecho / warn
 *   - `\prompt`                   → exec_command_prompt
 *   - `\set`, `\unset`            → exec_command_set / exec_command_unset
 *   - `\getenv`, `\setenv`        → exec_command_getenv / exec_command_setenv
 *   - `\errverbose`               → exec_command_errverbose
 *   - `\timing`                   → exec_command_timing
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
 *   - `\prompt -` (no-echo password prompting) is stubbed with a TODO that
 *     points at WP-24 (line editor). We currently fall back to echoing
 *     reads so the test surface is the same shape.
 *   - `\qecho` writes to `settings.logfile` if set, else stdout. Upstream
 *     additionally honours a separate "query output" file set via `\o`;
 *     that wiring lives in WP-15 and we leave the hook in place.
 */

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

import type {
  BackslashCmdSpec,
  BackslashContext,
  BackslashResult,
} from '../types/backslash.js';

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
 * command string. No args → run `$SHELL` interactively (we approximate with
 * `sh -i`). Failures still continue the REPL (upstream behaviour).
 */
export const cmdShell: BackslashCmdSpec = {
  name: '!',
  argMode: 'whole-line',
  helpKey: '!',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const line = ctx.restOfLine().trim();
    if (line.length === 0) {
      const shell = process.env.SHELL ?? '/bin/sh';
      spawnSync(shell, ['-i'], { stdio: 'inherit' });
    } else {
      spawnSync('sh', ['-c', line], { stdio: 'inherit' });
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
 */
const runEcho = (
  ctx: BackslashContext,
  write: (s: string) => void,
): BackslashResult => {
  const parts: string[] = [];
  let noNewline = false;
  let first = true;
  for (;;) {
    const arg = ctx.nextArg('normal');
    if (arg === null) break;
    if (first && arg === '-n') {
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
 * prompt prefix, and assign it to a psql variable. The `-` flag (no echo)
 * is used for password prompting; we stub it with a TODO (WP-24) and fall
 * back to echoed reads.
 *
 * If only one arg is given, it is the variable name and no prompt prefix
 * is shown. If two, the first is the prompt and the second the variable.
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
    if (args.length === 0) {
      writeErr(`\\${ctx.cmdName}: missing required argument\n`);
      return { status: 'error' };
    }

    // TODO(WP-24): support `-` flag for no-echo (password) reads through the
    // line editor. For now we treat it as a no-op prefix and read normally.
    let promptText = '';
    let varname: string;
    if (args.length === 1) {
      varname = args[0];
    } else {
      promptText = args[0];
      varname = args[1];
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: false,
    });
    try {
      const line = await new Promise<string>((resolve) => {
        if (promptText) process.stderr.write(promptText);
        rl.once('line', (l) => {
          resolve(l);
        });
        rl.once('close', () => {
          resolve('');
        });
      });
      if (!ctx.settings.vars.set(varname, line)) {
        writeErr(`\\${ctx.cmdName}: invalid variable name "${varname}"\n`);
        return { status: 'error' };
      }
      return { status: 'ok' };
    } finally {
      rl.close();
    }
  },
};

/**
 * `\set [varname [value...]]`
 *
 * - No args → list all variables (sorted, `name = 'value'` per line) to
 *   stdout. Upstream uses single-quotes around the value.
 * - One arg → set the variable to the empty string.
 * - More args → join the rest with a single space and set the variable.
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
    const value = values.join(' ');
    if (!ctx.settings.vars.set(name, value)) {
      writeErr(`\\${ctx.cmdName}: error while setting variable "${name}"\n`);
      return Promise.resolve({ status: 'error' });
    }
    return Promise.resolve({ status: 'ok' });
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

/**
 * `\getenv varname envvar`
 *
 * Read `process.env[envvar]` and store it under the psql variable `varname`.
 * An undefined env var unsets the psql variable.
 */
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
      ctx.settings.vars.unset(varname);
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
    const value = ctx.nextArg('no-vars');
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
 * `\errverbose` — print the last error in verbose form. We rely on the
 * mainloop to have stored `settings.lastErrorResult`; this command only
 * formats and prints. Without a saved error, upstream emits "There is no
 * previous error."
 */
export const cmdErrverbose: BackslashCmdSpec = {
  name: 'errverbose',
  helpKey: 'errverbose',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const e = ctx.settings.lastErrorResult;
    if (!e || (!e.message && !e.sqlstate)) {
      writeOut('There is no previous error.\n');
      return Promise.resolve({ status: 'ok' });
    }
    const sqlstate = e.sqlstate ?? '00000';
    const message = e.message ?? '';
    writeOut(`ERROR:  ${message}\nSQLSTATE: ${sqlstate}\n`);
    return Promise.resolve({ status: 'ok' });
  },
};

/**
 * `\timing [on|off|toggle]` — toggle `settings.timing`. With no arg the
 * value is flipped. Prints the new state to stdout.
 */
export const cmdTiming: BackslashCmdSpec = {
  name: 'timing',
  helpKey: 'timing',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const arg = ctx.nextArg('normal');
    let next: boolean;
    if (arg === null || arg.toLowerCase() === 'toggle') {
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
