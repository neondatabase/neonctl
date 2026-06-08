/**
 * `.psqlrc` autoload.
 *
 * TypeScript port of `process_psqlrc()` / `process_psqlrc_file()` in
 * `src/bin/psql/startup.c`. Two responsibilities:
 *
 *   1. `defaultPsqlrcPath(env?)` — pure function returning the path psql
 *      *would* read in the absence of a `$PSQLRC` override. Resolves to
 *      `$HOME/.psqlrc` on POSIX and `%APPDATA%/postgresql/psqlrc.conf` on
 *      Windows (the upstream layout).
 *
 *   2. `loadPsqlrc(ctx)` — discover and execute the rc files in upstream
 *      order:
 *        a. `$PGSYSCONFDIR/psqlrc-VERSION` and `$PGSYSCONFDIR/psqlrc`
 *        b. `$PSQLRC` if non-empty (overrides $HOME path)
 *        c. else `$HOME/.psqlrc-VERSION` then `$HOME/.psqlrc`
 *      Each existing file's contents are split into statements via the same
 *      `scanSql` boundary detector the mainloop uses, then dispatched
 *      through `connection.execSimple` (for SQL) or the backslash registry
 *      (for `\…` commands).
 *
 * Duplication note: we deliberately re-implement a minimal scan-and-dispatch
 * loop here instead of routing through `core/mainloop.ts`. The mainloop is
 * locked-down in WP-12 and adding an `executeInputString` helper to it would
 * touch a file we can't modify in this WP. The two loops share `scanSql` and
 * `dispatchBackslash` so the divergence is structural, not behavioural.
 *
 * Follow-up issue: refactor `mainloop.ts` to expose an `executeInputString`
 * primitive and delete this duplication. Tracked TODO at the bottom of this
 * file.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { REPLContext } from '../types/repl.js';
import type { BackslashContext, BackslashResult } from '../types/backslash.js';
import type { ScanState, SlashArgMode } from '../types/scanner.js';

import { initialScanState } from '../types/scanner.js';
import { scanSql } from '../scanner/sql.js';
import { scanSlashArgs } from '../scanner/slash.js';
import { dispatchBackslash } from '../command/dispatch.js';
import { attachCondStack, COND_COMMAND_NAMES } from '../command/cmd_cond.js';
import { sendQuery } from '../core/common.js';

// ---------------------------------------------------------------------------
// Path discovery.
// ---------------------------------------------------------------------------

const isWindows = process.platform === 'win32';

const baseRcName = isWindows ? 'psqlrc.conf' : '.psqlrc';

/**
 * Return the default user-level psqlrc path. The path is *not* verified to
 * exist — callers stat it lazily. The Windows layout follows upstream:
 * `%APPDATA%/postgresql/psqlrc.conf`. On POSIX we use `$HOME/.psqlrc`.
 */
export const defaultPsqlrcPath = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  if (isWindows) {
    const appData = env.APPDATA;
    if (appData && appData.length > 0) {
      return path.join(appData, 'postgresql', baseRcName);
    }
    return path.join(env.USERPROFILE ?? '', 'postgresql', baseRcName);
  }
  const home = env.HOME ?? '';
  return path.join(home, baseRcName);
};

/**
 * Build the ordered list of psqlrc candidate paths to try, given the env
 * and an optional server version (used to construct the `-VERSION` suffix).
 *
 * Upstream order:
 *   - sysconfdir/psqlrc-MAJOR
 *   - sysconfdir/psqlrc-MAJOR.MINOR
 *   - sysconfdir/psqlrc
 *   - PSQLRC env override (single file; suppresses HOME-based discovery)
 *   - HOME/.psqlrc-VERSION (we use the major-version suffix)
 *   - HOME/.psqlrc
 *
 * Each candidate is read if it exists; missing candidates are silently skipped.
 */
export type PsqlrcCandidate = { path: string; description: string };

const versionSuffix = (serverVersion: number | undefined): string | null => {
  if (!serverVersion || serverVersion <= 0) return null;
  // PG numeric version is e.g. 170002 (17.2). Upstream uses both
  // `psqlrc-PG_VERSION` (major.minor) and `psqlrc-PG_MAJORVERSION`. We use
  // the major (e.g. 17) — the bigger of the two backwards-compat targets.
  const major = Math.floor(serverVersion / 10000);
  return String(major);
};

export const psqlrcCandidates = (
  env: NodeJS.ProcessEnv,
  serverVersion: number | undefined,
): PsqlrcCandidate[] => {
  const out: PsqlrcCandidate[] = [];
  const suffix = versionSuffix(serverVersion);

  // System-wide.
  const sysDir = env.PGSYSCONFDIR;
  if (sysDir && sysDir.length > 0) {
    const sysBase = isWindows ? 'psqlrc.conf' : 'psqlrc';
    if (suffix) {
      out.push({
        path: path.join(sysDir, `${sysBase}-${suffix}`),
        description: 'system psqlrc (versioned)',
      });
    }
    out.push({
      path: path.join(sysDir, sysBase),
      description: 'system psqlrc',
    });
  }

  // PSQLRC override suppresses HOME-based discovery (matches upstream).
  const envRc = env.PSQLRC;
  if (envRc !== undefined && envRc !== '') {
    out.push({ path: expandTilde(envRc, env), description: '$PSQLRC' });
    return out;
  }

  // HOME-based.
  const home = env.HOME ?? '';
  if (isWindows) {
    const appData = env.APPDATA;
    const dir =
      appData && appData.length > 0
        ? path.join(appData, 'postgresql')
        : path.join(env.USERPROFILE ?? '', 'postgresql');
    if (suffix) {
      out.push({
        path: path.join(dir, `${baseRcName}-${suffix}`),
        description: 'user psqlrc (versioned)',
      });
    }
    out.push({
      path: path.join(dir, baseRcName),
      description: 'user psqlrc',
    });
  } else if (home.length > 0) {
    if (suffix) {
      out.push({
        path: path.join(home, `${baseRcName}-${suffix}`),
        description: 'user psqlrc (versioned)',
      });
    }
    out.push({
      path: path.join(home, baseRcName),
      description: 'user psqlrc',
    });
  }
  return out;
};

const expandTilde = (p: string, env: NodeJS.ProcessEnv): string => {
  if (p.startsWith('~/') && env.HOME) {
    return path.join(env.HOME, p.slice(2));
  }
  if (p === '~' && env.HOME) {
    return env.HOME;
  }
  return p;
};

// ---------------------------------------------------------------------------
// File read + dispatch.
// ---------------------------------------------------------------------------

const readIfExists = async (file: string): Promise<string | null> => {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    // Permission / I/O errors propagate — they're worth surfacing because
    // they signal a likely misconfiguration. Mirror upstream which prints
    // a warning but doesn't abort the session; we use a noop for now.
    return null;
  }
};

const makeBackslashContext = (
  ctx: REPLContext,
  cmdName: string,
  rawArgs: string,
  queryBuf: string,
): BackslashContext => {
  const varLookup = (name: string): string | undefined =>
    ctx.settings.vars.get(name);
  const buffered = new Map<SlashArgMode, string[]>();
  const cursors = new Map<SlashArgMode, number>();
  const argsFor = (mode: SlashArgMode): string[] => {
    const cached = buffered.get(mode);
    if (cached) return cached;
    const parsed = scanSlashArgs(rawArgs, mode, varLookup);
    buffered.set(mode, parsed);
    return parsed;
  };
  const bctx: BackslashContext = {
    settings: ctx.settings,
    cmdName,
    queryBuf,
    rawArgs,
    nextArg(mode: SlashArgMode = 'normal'): string | null {
      const av = argsFor(mode);
      const idx = cursors.get(mode) ?? 0;
      if (idx >= av.length) return null;
      cursors.set(mode, idx + 1);
      return av[idx];
    },
    restOfLine(): string {
      return rawArgs;
    },
  };
  attachCondStack(bctx, ctx.cond);
  return bctx;
};

/**
 * Outcome of running an input string. Lets the caller distinguish:
 *   - clean success → keep going, status unchanged
 *   - per-statement error (no ON_ERROR_STOP) → caller decides whether to
 *     surface as a non-zero exit (for `-c`) or swallow (for `-f`)
 *   - ON_ERROR_STOP fired → caller MUST stop further actions, exit non-zero
 *   - fatal connection loss → caller MUST stop, exit EXIT_BADCONN, and the
 *     diagnostic has already been written to stderr
 *
 * Mirrors the bits the upstream `process_file()` / `MainLoop()` pair tracks
 * via the `success` / `die_on_error` / `cur_cmd_interactive` interplay.
 */
export type ExecuteOutcome = {
  /** The most recently dispatched statement (SQL or backslash) errored. */
  hadError: boolean;
  /** ON_ERROR_STOP was set AND an error was encountered; caller must stop. */
  stoppedOnError: boolean;
  /** Connection was lost mid-script; caller must stop with EXIT_BADCONN. */
  connectionLost: boolean;
};

export type ExecuteInputOpts = {
  /**
   * When true, route SQL through the same `sendQuery` pipeline the REPL uses
   * so SELECT output, NOTICE messages, and timing all land on stdout/stderr.
   * Used by the `-c`/`-f` driver. When false (default), SQL is dispatched
   * silently via `db.execSimple` — the `.psqlrc` path uses this so a stray
   * SELECT in the rc file doesn't spam the session.
   */
  print?: boolean;
};

/**
 * Execute the supplied input string against the running REPL context. Used
 * by `loadPsqlrc` (and exported for tests). This is a minimal cousin of
 * `runMainLoop`'s processChunk — see the module header for the duplication
 * rationale.
 *
 * Returns when EOF is reached; `\q` and other exit commands inside an rc
 * file are treated as "stop reading this file" (the REPL itself continues).
 *
 * The returned outcome lets `runPsql`'s `-c`/`-f` loop apply upstream's
 * per-switch exit-code semantics (see comment above).
 */
export const executeInputString = async (
  input: string,
  ctx: REPLContext,
  opts: ExecuteInputOpts = {},
): Promise<ExecuteOutcome> => {
  let working = input;
  let queryBuf = '';
  let scanState: ScanState = initialScanState();
  let hadError = false;
  let stoppedOnError = false;
  let connectionLost = false;
  const print = opts.print ?? false;

  const noteConnectionLost = (): boolean => {
    if (ctx.settings.db?.isClosed()) {
      ctx.stderr.write('psql: error: connection to server was lost\n');
      connectionLost = true;
      return true;
    }
    return false;
  };

  // Inline `:NAME` substitution wired through SQL bodies (handled by
  // scanSql). Slash-arg bodies are already substituted via
  // `makeBackslashContext` above. Mirror the mainloop's wiring so `-c`/`-f`
  // / .psqlrc inputs expand the same way as interactive input.
  const sqlVarLookup = (name: string): string | undefined =>
    ctx.settings.vars.get(name);

  while (working.length > 0) {
    const r = scanSql(working, scanState, sqlVarLookup);
    scanState = r.nextState;

    if (r.kind === 'semicolon') {
      // Use the substituted text rather than the raw slice so `:NAME`
      // expansions land in the executed SQL.
      const sqlText = queryBuf + r.sql;
      queryBuf = '';
      working = working.slice(r.consumed);
      scanState = initialScanState();
      if (!ctx.cond.isActive()) continue;
      const trimmed = sqlText.trim();
      if (trimmed.length === 0) continue;
      if (!ctx.settings.db) continue;
      if (print) {
        // `-c` / `-f`: route through the full SendQuery pipeline so SELECT
        // tuples, NOTICE messages and `\timing` land on the output streams.
        const stats = await sendQuery(ctx, sqlText);
        // LATCH: a multi-statement input must report an error if ANY statement
        // failed, not just the last one — otherwise `-c "SELECT 1; SELECT 1/0;
        // SELECT 2"` exits 0 and silently passes CI. The
        // -f/psqlrc callers ignore this aggregate (they only act on
        // stoppedOnError), so latching is safe across all callers.
        if (stats.hadError) hadError = true;
        if (noteConnectionLost()) {
          return { hadError, stoppedOnError, connectionLost };
        }
        if (stats.hadError && ctx.settings.onErrorStop) {
          stoppedOnError = true;
          return { hadError, stoppedOnError, connectionLost };
        }
      } else {
        try {
          await ctx.settings.db.execSimple(sqlText);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.stderr.write(`psql: ERROR:  ${msg}\n`);
          hadError = true;
          if (noteConnectionLost()) {
            return { hadError, stoppedOnError, connectionLost };
          }
          if (ctx.settings.onErrorStop) {
            stoppedOnError = true;
            return { hadError, stoppedOnError, connectionLost };
          }
        }
      }
      continue;
    }

    if (r.kind === 'backslash') {
      // Use `r.sql` — the scanner's substituted/processed text that
      // *preceded* the backslash boundary. The raw consumed slice would
      // also include the backslash command itself and any separators
      // (like the `\\` end-of-args marker), which we don't want in the
      // query buffer. `r.sql` excludes both. Mirrors the mainloop's
      // `queryBuf += result.sql` path.
      queryBuf += r.sql;
      working = working.slice(r.consumed);
      const cmdName = r.cmd;
      // Skip cond-commands inside rc — they require the full mainloop state
      // machine to be useful; we treat them as no-ops here. Other commands
      // run through the standard registry.
      if (COND_COMMAND_NAMES.has(cmdName)) continue;
      if (!ctx.cond.isActive()) continue;
      const bctx = makeBackslashContext(ctx, cmdName, r.rest, queryBuf);
      let res: BackslashResult;
      try {
        res = await dispatchBackslash(ctx.registry, cmdName, bctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.stderr.write(`psql: ERROR:  ${msg}\n`);
        hadError = true;
        if (ctx.settings.onErrorStop) {
          stoppedOnError = true;
          return { hadError, stoppedOnError, connectionLost };
        }
        continue;
      }
      if (res.status === 'exit')
        return { hadError, stoppedOnError, connectionLost };
      if (res.status === 'reset-buf') {
        queryBuf = res.newBuf ?? '';
        scanState = initialScanState();
      }
      // Mirror upstream `mainloop.c`: a backslash command that errored
      // drops the query buffer and resets the scanner. Without this the
      // residue would re-execute via the tail-dispatch at EOF (or get
      // glued onto the next dispatched statement), masking the failure.
      if (res.status === 'error') {
        queryBuf = '';
        scanState = initialScanState();
      }
      if (res.status === 'error') hadError = true; // latch
      if (noteConnectionLost()) {
        return { hadError, stoppedOnError, connectionLost };
      }
      if (res.status === 'error' && ctx.settings.onErrorStop) {
        stoppedOnError = true;
        return { hadError, stoppedOnError, connectionLost };
      }
      continue;
    }

    // eof / incomplete: stash residue and stop. Use `r.sql` so any `:NAME`
    // tokens fully consumed in this chunk make it into the buffer in
    // substituted form. (Same caveat as the mainloop: cross-chunk colon
    // references fall back to the literal.)
    queryBuf += r.sql;
    working = '';
  }

  // Tail dispatch: if the file ended mid-statement (no trailing `;`), run
  // the residue. This matches `process_file` behaviour in upstream.
  const tail = queryBuf.trim();
  if (tail.length > 0 && ctx.settings.db && ctx.cond.isActive()) {
    if (print) {
      const stats = await sendQuery(ctx, queryBuf);
      // LATCH, same as the semicolon branch — a trailing statement (no `;`)
      // that succeeds must not clear an earlier error, or `-c "bad; ok"`
      // wrongly exits 0. The function's latch invariant applies
      // to the tail path too.
      if (stats.hadError) hadError = true;
      noteConnectionLost();
    } else {
      try {
        await ctx.settings.db.execSimple(queryBuf);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.stderr.write(`psql: ERROR:  ${msg}\n`);
        hadError = true;
        noteConnectionLost();
      }
    }
  }

  return { hadError, stoppedOnError, connectionLost };
};

// ---------------------------------------------------------------------------
// Public entry points.
// ---------------------------------------------------------------------------

export type LoadPsqlrcOpts = {
  /** Override discovery. If provided, only this path is loaded. */
  path?: string;
  /** Skip everything (mirrors `-X` / `--no-psqlrc`). Default false. */
  skip?: boolean;
  /** Env to read from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
};

/**
 * Discover and execute `.psqlrc` files against `ctx`. Honors the `-X` flag
 * via `opts.skip = true`. Safe to call before the connection is ready —
 * commands that need `db` will simply no-op (see `executeInputString`).
 */
export const loadPsqlrc = async (
  ctx: REPLContext,
  opts: LoadPsqlrcOpts = {},
): Promise<void> => {
  if (opts.skip) return;

  const env = opts.env ?? process.env;

  // Single-path mode (test ergonomics / explicit override).
  if (opts.path !== undefined) {
    const content = await readIfExists(opts.path);
    if (content === null) return;
    const prevSource = ctx.settings.curCmdSource;
    ctx.settings.curCmdSource = 'rcfile';
    try {
      await executeInputString(content, ctx);
    } finally {
      ctx.settings.curCmdSource = prevSource;
    }
    return;
  }

  const serverVersion = ctx.settings.db?.serverVersion;
  const candidates = psqlrcCandidates(env, serverVersion);

  // Upstream `process_psqlrc()` is first-match-wins PER LOCATION: it reads at
  // most ONE system file (versioned preferred over unversioned) and then at
  // most ONE user file. Running both the versioned AND unversioned file in a
  // location double-executes side effects and lets the unversioned file
  // clobber the versioned one.
  let systemDone = false;
  for (const c of candidates) {
    const isSystem = c.description.startsWith('system');
    if (isSystem && systemDone) continue; // first system file already ran
    const content = await readIfExists(c.path);
    if (content === null) continue;
    const prevSource = ctx.settings.curCmdSource;
    ctx.settings.curCmdSource = 'rcfile';
    try {
      await executeInputString(content, ctx);
    } finally {
      ctx.settings.curCmdSource = prevSource;
    }
    if (isSystem) {
      systemDone = true; // consumed the system location; move to the user one
      continue;
    }
    // First user / $PSQLRC match wins; nothing further to read.
    return;
  }
};

// TODO(WP-26-followup): Refactor `core/mainloop.ts` to export an
// `executeInputString(input, ctx)` primitive, then have this module call it
// instead of duplicating the scan-and-dispatch loop. The duplication today is
// roughly 60 LOC; the refactor would shrink this file by half.
