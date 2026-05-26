import { spawn, type ChildProcess } from 'child_process';
import { basename } from 'path';

/**
 * Pager spawning, modeled on psql's PageOutput / ClosePager / IsPagerNeeded
 * in `src/fe_utils/print.c`.
 *
 * High-level mapping to the upstream C:
 *   - `topt.pager` ∈ {off, on, always} maps to upstream values 0/1/2.
 *   - `topt.pagerMinLines` matches `pager_min_lines`.
 *   - `PSQL_PAGER` overrides `PAGER`, which in turn overrides the default
 *     (`less` on POSIX). Whitespace-only values disable the pager.
 *   - When the chosen command name is `less` and `LESS` is unset we set
 *     `LESS=FRX` — psql doesn't do this directly in print.c, but it's the
 *     same default the upstream client (`psql/startup.c`) installs at boot,
 *     so users see the same behavior.
 *   - `pclose` is replaced by an explicit `out.end()` + wait-for-exit.
 *
 * SIGPIPE: upstream calls `disable_sigpipe_trap()` around `popen`. Node
 * already ignores SIGPIPE on its writable streams (we get EPIPE errors
 * instead), so we just swallow EPIPE on the pager stdin stream — the
 * caller's writes after the pager quit are intentionally dropped.
 */

export type PagerHandle = {
  /** Stream to write into (the pager's stdin, or process.stdout when no pager). */
  out: NodeJS.WritableStream;
  /** Whether a pager was actually spawned. */
  spawned: boolean;
  /** Close the pager (waits for it to exit). */
  close(): Promise<number>;
};

export type OpenPagerOpts = {
  /** Lines in the expected output (for IsPagerNeeded). When undefined, never auto-skip. */
  lines?: number;
  /** topt.pager setting: 'off' (never), 'on' (when needed), 'always'. */
  pager: 'off' | 'on' | 'always';
  /** topt.pagerMinLines — minimum lines before triggering. */
  pagerMinLines: number;
  /** Force a specific pager command (used by \pset watch_pager too). Falls back to PSQL_PAGER / PAGER env. */
  pagerCmd?: string;
  /** Override env (for tests). */
  env?: NodeJS.ProcessEnv;
  /** Override stdout (for tests). */
  stdout?: NodeJS.WritableStream;
  /** Override terminal height check (for tests / non-TTY). */
  terminalHeight?: number;
  /** Override TTY check (for tests). */
  isTty?: boolean;
};

/**
 * Resolve the pager command string. Mirrors upstream:
 *   PSQL_PAGER → PAGER → DEFAULT_PAGER (`less` on POSIX, none on Windows).
 *
 * Empty / whitespace-only env values FALL THROUGH to the next candidate. This
 * deliberately diverges from strict upstream (where `PSQL_PAGER=''` would
 * disable the pager outright) because in Node a spawned child cannot easily
 * "unset" an inherited env var — tests have to override it with the empty
 * string. Treating empty values as "unset" matches the conformance spec
 * (`tests/psql-conformance/tap/030_pager.spec.ts`) and lets `PSQL_PAGER=''`
 * fall through to PAGER, which is the user-friendly interpretation.
 *
 * Users who want to disable the pager unconditionally should set
 * `\pset pager off` (preferred) or unset both env vars before launch.
 */
const resolvePagerCmd = (opts: OpenPagerOpts): string => {
  const env = opts.env ?? process.env;

  const candidates: (string | undefined)[] = [
    opts.pagerCmd,
    env.PSQL_PAGER,
    env.PAGER,
  ];

  for (const c of candidates) {
    if (c === undefined) continue;
    // Empty or whitespace-only → treat as "not set" and try the next slot.
    if (/^\s*$/.test(c)) continue;
    return c;
  }

  // DEFAULT_PAGER: `less` on POSIX; nothing on Windows.
  if (process.platform === 'win32') return '';
  return 'less';
};

const getIsTty = (opts: OpenPagerOpts): boolean => {
  if (opts.isTty !== undefined) return opts.isTty;
  const stream = opts.stdout ?? process.stdout;
  // Some test streams won't have isTTY.
  const tty = (stream as NodeJS.WriteStream).isTTY;
  return Boolean(tty);
};

const getTerminalHeight = (opts: OpenPagerOpts): number => {
  if (opts.terminalHeight !== undefined) return opts.terminalHeight;
  const stream = opts.stdout ?? process.stdout;
  const rows = (stream as NodeJS.WriteStream).rows;
  // If we can't tell, fall back to 24 (classic VT100 default).
  return typeof rows === 'number' && rows > 0 ? rows : 24;
};

/** Standalone helper to determine whether a pager is needed at all. */
export const isPagerNeeded = (opts: OpenPagerOpts): boolean => {
  if (opts.pager === 'off') return false;

  const cmd = resolvePagerCmd(opts);
  if (cmd === '') return false;

  if (opts.pager === 'always') return true;

  // pager === 'on'
  if (!getIsTty(opts)) return false;

  if (opts.lines === undefined) return false;

  const threshold = Math.max(opts.pagerMinLines, getTerminalHeight(opts));
  return opts.lines >= threshold;
};

// ---------------------------------------------------------------------------
// `shouldPage` — convenience for callers that have a query result in hand
// and want to decide whether to route it through a pager, without needing to
// pre-render to count lines.
//
// Decision logic (matches `isPagerNeeded` ordering):
//   - `popt.pager === 'off'`           → never page
//   - explicit `\o FILE` redirect      → never page (caller passes
//                                         `redirectedOutput: true`)
//   - resolved pager cmd is empty      → never page
//   - `popt.pager === 'always'`        → always page (force-on, even when
//                                         the target stream is not a TTY —
//                                         the user explicitly asked for it)
//   - target stream is not a TTY       → never page (auto mode only)
//   - `popt.pager === 'on'` (default)  → page when estimated rendered lines
//                                         exceed `terminalHeight ⨯
//                                         pagerMinLines` threshold. We
//                                         estimate as `rowCount + small
//                                         header overhead`; the printer's
//                                         actual line count may differ
//                                         slightly but this matches
//                                         upstream's `IsPagerNeeded` heuristic
//                                         (rows-as-lines, plus a fixed
//                                         per-table overhead).
// ---------------------------------------------------------------------------

export type ShouldPageOpts = {
  /** topt.pager setting. */
  pager: 'off' | 'on' | 'always';
  /** topt.pagerMinLines — minimum lines before triggering. */
  pagerMinLines: number;
  /** Approximate row count of the result we're about to render. */
  rowCount: number;
  /**
   * Approximate column count — unused by `IsPagerNeeded` itself, retained
   * because callers may want it for a future wrap-aware heuristic.
   */
  colCount: number;
  /** The actual stream the renderer would write to (used for the TTY check). */
  output: NodeJS.WritableStream;
  /**
   * True when `\o FILE` (or `\g FILE`) has redirected the query output. In
   * that case the pager MUST NOT activate — output should land in the file.
   */
  redirectedOutput: boolean;
  /** Overrides for env / TTY / height (tests). */
  env?: NodeJS.ProcessEnv;
  isTty?: boolean;
  terminalHeight?: number;
  /** Forces a specific pager command (mirrors upstream's `--pager-cmd`). */
  pagerCmd?: string;
};

/**
 * Decide whether a result of `rowCount` rows by `colCount` columns should be
 * routed through the pager when written to `output`.
 *
 * NOTE on `pager === 'always'`: the TTY check is INTENTIONALLY skipped in
 * this case. Upstream's `\pset pager always` is a user-explicit "force the
 * pager on" override; honouring it on a pipe matches the integration test
 * harness contract (see `tests/psql-conformance/tap/030_pager.spec.ts`) where
 * the child process has no controlling TTY but the spec still requires the
 * configured PAGER to be invoked. For `pager === 'on'` (auto mode) we keep
 * the TTY guard so non-interactive runs don't spuriously spawn `less`.
 */
export const shouldPage = (opts: ShouldPageOpts): boolean => {
  if (opts.pager === 'off') return false;
  if (opts.redirectedOutput) return false;

  // Rough heuristic for "lines" — header (3) + rows + footer (1). Matches
  // upstream `IsPagerNeeded` which counts rendered table lines.
  const HEADER_LINES = 3;
  const FOOTER_LINES = 1;
  const estimatedLines =
    HEADER_LINES + Math.max(0, opts.rowCount) + FOOTER_LINES;

  // TTY check: explicit override wins, else inspect the stream's own isTTY.
  const isTty =
    opts.isTty !== undefined
      ? opts.isTty
      : Boolean((opts.output as NodeJS.WriteStream).isTTY);

  // `pager === 'always'` bypasses the TTY guard — see the docstring above.
  // The remaining gates (resolved cmd, redirected output, off) are enforced
  // inside `isPagerNeeded`.
  if (opts.pager !== 'always' && !isTty) return false;

  return isPagerNeeded({
    pager: opts.pager,
    pagerMinLines: opts.pagerMinLines,
    pagerCmd: opts.pagerCmd,
    env: opts.env,
    stdout: opts.output,
    isTty,
    terminalHeight: opts.terminalHeight,
    lines: estimatedLines,
  });
};

const SHELL_META = /[\s|;><]/;

type SpawnArgs = {
  command: string;
  args: string[];
  shell: boolean;
};

const parsePagerCmd = (cmd: string): SpawnArgs => {
  // Match upstream behavior: when the value looks shell-y, hand it off to
  // /bin/sh -c. Otherwise treat it as a direct argv[0].
  if (SHELL_META.test(cmd)) {
    return { command: cmd, args: [], shell: true };
  }
  return { command: cmd, args: [], shell: false };
};

const buildPagerEnv = (
  cmd: string,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  // psql sets LESS=FRX by default; mirror it when the resolved pager is
  // `less` and the caller hasn't already set LESS.
  if (env.LESS === undefined) {
    // Pull out the first whitespace-separated token to detect `less` even
    // when args follow (e.g. "less -S").
    const firstToken = cmd.trim().split(/\s+/, 1)[0] ?? '';
    const program = basename(firstToken);
    if (program === 'less') {
      env.LESS = 'FRX';
    }
  }
  return env;
};

const noOpHandle = (out: NodeJS.WritableStream): PagerHandle => ({
  out,
  spawned: false,
  close: () => Promise.resolve(0),
});

/**
 * Returns a PagerHandle. Caller writes data to `out`, then calls `close()`.
 * If no pager spawned (pager='off', not a TTY, or fewer lines than threshold),
 * `out` is `stdout`.
 */
export const openPager = (opts: OpenPagerOpts): PagerHandle => {
  const stdout = opts.stdout ?? process.stdout;

  if (!isPagerNeeded(opts)) {
    return noOpHandle(stdout);
  }

  const cmd = resolvePagerCmd(opts);
  // isPagerNeeded already verified cmd is non-empty, but guard for safety.
  if (cmd === '') {
    return noOpHandle(stdout);
  }

  const { command, shell } = parsePagerCmd(cmd);
  const baseEnv = opts.env ?? process.env;
  const childEnv = buildPagerEnv(cmd, baseEnv);

  let child: ChildProcess;
  try {
    child = spawn(command, [], {
      stdio: ['pipe', 'inherit', 'inherit'],
      shell,
      env: childEnv,
    });
  } catch {
    // If the pager fails to spawn, fall back to stdout (matches upstream:
    // `if (pagerpipe) return pagerpipe; restore_sigpipe_trap(); ... return stdout`).
    return noOpHandle(stdout);
  }

  const stdin = child.stdin;
  if (stdin === null) {
    // Should not happen given stdio: ['pipe', ...], but be defensive.
    return noOpHandle(stdout);
  }

  // Swallow EPIPE: the user can quit the pager early, after which any
  // pending writes will fail with EPIPE. Upstream relies on SIGPIPE being
  // ignored to short-circuit the write loop; we just drop the error.
  stdin.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') {
      // Re-throw anything unexpected.
      throw err;
    }
  });

  const exitPromise = new Promise<number>((resolve) => {
    const settle = (code: number | null): void => {
      resolve(code ?? 0);
    };
    child.once('exit', (code) => {
      settle(code);
    });
    child.once('error', () => {
      // If the child errored (e.g. ENOENT), surface a non-zero exit code
      // but don't throw — the caller's writes will have hit EPIPE which
      // we already swallow.
      settle(127);
    });
  });

  return {
    out: stdin,
    spawned: true,
    close: () => {
      // End stdin then wait for the pager to drain & exit.
      if (!stdin.writableEnded) {
        try {
          stdin.end();
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code !== 'EPIPE') throw err;
        }
      }
      return exitPromise;
    },
  };
};
