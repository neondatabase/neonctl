// PTY helpers for the tab-completion conformance spec.
//
// The upstream tab-completion TAP test (`010_tab_completion.pl`) drives
// psql via `IPC::Run` with `IO::Pty`. Node's plain `child_process.spawn`
// can't satisfy psql's readline path: readline only enters its
// interactive editing mode when `isatty(STDIN_FILENO)` is true. To
// faithfully port the upstream test we need a pseudo-terminal connecting
// the parent (vitest worker) to the child (TS psql).
//
// `node-pty` provides that bridge. Each `spawnPsql(...)` call returns a
// thin handle with:
//   - `term`     — the underlying IPty (writable for keystrokes)
//   - `output()` — the cumulative raw output (with ANSI escapes intact)
//   - `clean()`  — the cumulative output with ANSI/CSI sequences stripped
//   - `clear()`  — reset the cumulative buffers (useful between checks)
//
// The primitives `waitForPrompt`, `sendKeys`, `captureLine`, `kill` mirror
// the `query_until` / `quit` operations the perl harness uses on each PTY
// session. See `tap/010_tab_completion.spec.ts` for the consumer.
//
// Notes on platform quirks (Linux, macOS, Windows):
//   - bun's install pipeline drops the executable bit on
//     `node_modules/node-pty/prebuilds/<plat-arch>/spawn-helper`. We
//     re-chmod those at module-load time so the binding actually works
//     after a fresh `bun install`. The fix is idempotent.
//   - Windows uses ConPTY rather than a real PTY; we don't gate on it
//     here because the conformance run is linux/macOS-only in CI.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import stripAnsi from 'strip-ansi';

import { getPgConn, setupPg } from './pg-fixture.js';

// ---------------------------------------------------------------------------
// One-time setup: make sure the prebuilt spawn-helper for every platform
// shipped in `node-pty/prebuilds` is executable. bun's lockfile-driven
// install path tends to clear the executable bit; node-pty's `posix_spawnp`
// then fails at runtime with "posix_spawnp failed".
//
// We chmod all platform variants we ship — picking the right one is
// node-pty's problem — and ignore ENOENT for platforms we don't care
// about on this host.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const DIST_PSQL = join(REPO_ROOT, 'dist', 'psql', 'index.js');

const ensurePtyHelpersExecutable = (): void => {
  const root = join(REPO_ROOT, 'node_modules', 'node-pty', 'prebuilds');
  if (!existsSync(root)) return;
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return;
  }
  for (const d of dirs) {
    const helper = join(root, d, 'spawn-helper');
    if (!existsSync(helper)) continue;
    try {
      const st = statSync(helper);
      // Only chmod if it isn't already +x.
      if ((st.mode & 0o111) === 0) {
        chmodSync(helper, 0o755);
      }
    } catch {
      // best-effort
    }
  }
};

ensurePtyHelpersExecutable();

// ---------------------------------------------------------------------------
// Run condition shared with the other TAP specs.
// ---------------------------------------------------------------------------

export const RUN_INTEGRATION = process.env.RUN_INTEGRATION === '1';
export const DIST_EXISTS = existsSync(DIST_PSQL);
export const SHOULD_RUN_INTEGRATION = RUN_INTEGRATION && DIST_EXISTS;

// ---------------------------------------------------------------------------
// Lazy node-pty import.
//
// We import `node-pty` lazily so this module can be loaded for tests that
// SKIP the spec (e.g. when `RUN_INTEGRATION=0` or the dist build is
// missing). That way the spec file imports do not crash when the binding
// isn't ready.
// ---------------------------------------------------------------------------

type IPty = {
  write(data: string): void;
  kill(signal?: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
};

type PtyModule = {
  spawn(
    file: string,
    args: string[],
    opts: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
    },
  ): IPty;
};

let ptyMod: PtyModule | null = null;

const loadPty = async (): Promise<PtyModule> => {
  if (ptyMod) return ptyMod;
  // Built at runtime so tsc doesn't choke if the package is missing.
  const moduleName = 'node-pty';
  const m = (await import(moduleName)) as unknown as
    | PtyModule
    | { default: PtyModule };
  ptyMod = 'spawn' in m ? m : m.default;
  return ptyMod;
};

// ---------------------------------------------------------------------------
// Connection helpers (shared with the rest of the conformance harness).
// ---------------------------------------------------------------------------

export const ensureFixture = async (): Promise<void> => {
  await setupPg();
};

export const buildUri = (): string => {
  const conn = getPgConn();
  const u = new URL(`postgresql://${conn.host}:${conn.port}/${conn.db}`);
  u.username = conn.user;
  u.password = conn.password;
  u.searchParams.set('sslmode', 'disable');
  return u.toString();
};

// ---------------------------------------------------------------------------
// Launcher script that imports `runPsql` from the dist build and runs it
// with the URI as argv[0]. We write it once per test process under
// `mkdtemp(...)` so multiple specs don't trample each other.
//
// This mirrors the existing `makeLauncher` in tap/_helpers.ts; we keep
// this as a private function here so the PTY tests don't depend on the
// non-PTY helper (it spawns the launcher via `child_process` which we
// avoid for tab completion). The launcher is the same.
// ---------------------------------------------------------------------------

type LauncherPaths = {
  dir: string;
  launcher: string;
};

export const makeLauncher = (prefix = 'pty-launcher'): LauncherPaths => {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const launcher = join(dir, 'launcher.mjs');
  const distUrl = new URL(`file://${DIST_PSQL}`).href;
  const code = `
import { runPsql } from ${JSON.stringify(distUrl)};
const argv = process.argv.slice(2);
const code = await runPsql(argv);
process.exit(code);
`;
  writeFileSync(launcher, code, 'utf8');
  return { dir, launcher };
};

// ---------------------------------------------------------------------------
// PTY handle and primitives.
// ---------------------------------------------------------------------------

export type PtyHandle = {
  term: IPty;
  /** Cumulative raw output (with ANSI escapes). */
  output: () => string;
  /** Cumulative ANSI-stripped output. */
  clean: () => string;
  /** Reset the cumulative buffers. */
  clear: () => void;
  /** Resolves when the child exits. */
  exited: Promise<{ exitCode: number; signal?: number }>;
};

export type SpawnPsqlOpts = {
  /**
   * Override the binary invocation. The default uses the TS psql via the
   * dist launcher (`node <launcher> <uri>`). Setting `PSQL_BINARY` in the
   * environment lets you run the same spec against vanilla psql:
   *   PSQL_BINARY=/usr/local/bin/psql RUN_INTEGRATION=1 vitest run ...
   * The wrapper invokes it as `<bin> <uri> <args...>`.
   */
  binary?: string;
  /** Extra args passed after the URI. */
  args?: string[];
  /** Connection URI. Defaults to `buildUri()`. */
  uri?: string;
  /** Cwd for the child. Defaults to a fresh mkdtemp. */
  cwd?: string;
  /** Initial terminal size. */
  cols?: number;
  rows?: number;
  /** Extra env vars merged on top of process.env. */
  env?: Record<string, string | undefined>;
};

/**
 * Spawn a psql session bound to a PTY.
 *
 * When `PSQL_BINARY` is set in the env, we invoke that binary directly with
 * `[uri, ...args]`. Otherwise we run our TS psql via the dist launcher,
 * matching the call shape used in `tap/_helpers.ts`. The launcher is built
 * once and dropped under tmpdir().
 */
export const spawnPsql = async (
  opts: SpawnPsqlOpts = {},
): Promise<PtyHandle> => {
  const pty = await loadPty();
  const env: Record<string, string | undefined> = {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    PAGER: '',
    PSQL_PAGER: '',
    TERM: 'xterm-256color',
    // Disable any startup banner / pager / pset side-effects that would
    // race the prompt-detection logic. -X also keeps history isolated.
    PSQL_HISTORY: '/dev/null',
    PSQLRC: '/dev/null',
    ...opts.env,
  };
  const uri = opts.uri ?? buildUri();
  const args = opts.args ?? ['-X'];
  const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), 'psql-pty-cwd-'));

  const externalBinary = opts.binary ?? process.env.PSQL_BINARY ?? '';
  const file = externalBinary !== '' ? externalBinary : process.execPath;
  // When using the embedded TS psql, we invoke `node <launcher> <uri>`;
  // when using a vanilla psql binary, we invoke `<binary> <uri>`.
  const argv: string[] =
    externalBinary !== ''
      ? [uri, ...args]
      : [makeLauncher().launcher, uri, ...args];

  const term = pty.spawn(file, argv, {
    name: 'xterm-256color',
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 30,
    cwd,
    env,
  });

  let raw = '';
  term.onData((d) => {
    raw += d;
  });

  const exited = new Promise<{ exitCode: number; signal?: number }>((res) => {
    term.onExit((e) => {
      res({ exitCode: e.exitCode, signal: e.signal });
    });
  });

  return {
    term,
    output: () => raw,
    clean: () => stripAnsi(raw),
    clear: () => {
      raw = '';
    },
    exited,
  };
};

/**
 * Block until the given regex matches the (ANSI-stripped) cumulative
 * output. Returns the captured clean output. Rejects on timeout.
 *
 * The default prompt regex matches the upstream psql REPL prompt
 * shape:
 *
 *   <dbname>=> <cursor>    # default — non-superuser session
 *   <dbname>=# <cursor>    # superuser session
 *   <dbname>-> <cursor>    # continuation, unterminated query
 *   <dbname>-# <cursor>    # continuation, unterminated query, su
 *   <dbname>'> <cursor>    # continuation, unterminated single quote
 *   <dbname>"> <cursor>    # continuation, unterminated double quote
 *   <dbname>(> <cursor>    # continuation, unterminated `(`
 *
 * Upstream uses `<dbname>=#` for the `postgres` superuser DB and
 * `<dbname>=>` for any other role; the testcontainers fixture uses a
 * non-superuser role (`test`) on the `test` database, so our default
 * prompt is `test=>`. The regex below is intentionally lenient — it
 * matches any `<word>[=\-'"(][>#]\s` sequence to cover both fixtures.
 */
export const DEFAULT_PROMPT_RE = /\b\w+[=\-'"(][>#]\s/;

export const waitForPrompt = async (
  handle: PtyHandle,
  opts: { timeoutMs?: number; pattern?: RegExp } = {},
): Promise<string> => {
  const pattern = opts.pattern ?? DEFAULT_PROMPT_RE;
  return waitForOutput(handle, pattern, opts.timeoutMs);
};

/**
 * Block until the (ANSI-stripped) cumulative output matches `pattern`.
 * Polls every 25ms. Resolves with the matched-so-far clean buffer.
 */
export const waitForOutput = (
  handle: PtyHandle,
  pattern: RegExp,
  timeoutMs = 5_000,
): Promise<string> => {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      const buf = handle.clean();
      if (pattern.test(buf)) {
        clearInterval(tick);
        res(buf);
        return;
      }
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(tick);
        rej(
          new Error(
            `waitForOutput timed out after ${timeoutMs}ms waiting for ${pattern}\n` +
              `--- last 1000 chars of clean output ---\n${buf.slice(-1000)}`,
          ),
        );
      }
    }, 25);
  });
};

/**
 * Write raw bytes to the PTY. Common control codes:
 *   - Tab:        '\t'
 *   - Enter:      '\r' (PTYs normally echo back '\r\n')
 *   - Esc:        '\x1b'
 *   - Ctrl-C:     '\x03'
 *   - Ctrl-D:     '\x04'
 *   - Ctrl-U:     '\x15' (kill-line, used by upstream `clear_line`)
 *   - Backspace:  '\x7f'
 */
export const sendKeys = (handle: PtyHandle, text: string): void => {
  handle.term.write(text);
};

/**
 * Capture the current visible "command line" — the slice of clean output
 * from the most recent prompt to the trailing edge, with whitespace
 * collapsed. Useful for asserting "after Tab, the visible line reads X".
 *
 * If multiple prompts are visible in the buffer (e.g. cleared queries),
 * we capture from the LAST prompt onward.
 */
export const captureLine = (
  handle: PtyHandle,
  promptRe = DEFAULT_PROMPT_RE,
): string => {
  const buf = handle.clean();
  // Find the index just past the last prompt match.
  let lastMatchEnd = 0;
  for (const m of buf.matchAll(new RegExp(promptRe.source, 'g'))) {
    lastMatchEnd = (m.index ?? 0) + m[0].length;
  }
  return buf.slice(lastMatchEnd);
};

/**
 * Best-effort teardown: send `\q\r` to give psql a chance to drain, then
 * SIGKILL if it doesn't exit within `graceMs`.
 */
export const kill = async (
  handle: PtyHandle,
  graceMs = 1_000,
): Promise<void> => {
  try {
    handle.term.write('\\q\r');
  } catch {
    // ignore
  }
  const timed = new Promise<'timeout'>((res) =>
    setTimeout(() => {
      res('timeout');
    }, graceMs),
  );
  const outcome = await Promise.race([
    handle.exited.then(() => 'exited' as const),
    timed,
  ]);
  if (outcome === 'timeout') {
    try {
      handle.term.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
};

// ---------------------------------------------------------------------------
// Misc utility — small helpers used by the spec.
// ---------------------------------------------------------------------------

/** Resolve a binary on PATH, returning the absolute path or null. */
export const which = (cmd: string): string | null => {
  const r = spawnSync('command', ['-v', cmd], {
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: '/bin/sh',
  });
  if (r.status !== 0) return null;
  const out = r.stdout.toString('utf8').trim();
  return out === '' ? null : out;
};
