/**
 * psql Prompt renderer.
 *
 * TypeScript port of `get_prompt()` from `src/bin/psql/prompt.c`. Walks the
 * prompt template (PROMPT1/PROMPT2/PROMPT3) and expands `%`-escapes against
 * a `PromptContext` snapshot.
 *
 * Differences from upstream:
 *
 *  - Upstream takes `promptStatus_t status, ConditionalStack cstack` and
 *    pulls everything else off `pset`. We accept an explicit `PromptContext`
 *    so the renderer is a pure function (easier to test, no module-level
 *    state).
 *  - `%s` ("service name") is provided from `settings.vars.SERVICE` per
 *    upstream. We keep that behaviour. The WP-07 spec mentions a "current
 *    timestamp" semantic for `%s`/`%S` — that is NOT what psql does today,
 *    so we follow upstream rather than the spec note.
 *  - `%S` is `search_path` from the connection's GUC report (upstream uses
 *    `PQparameterStatus(pset.db, "search_path")`). With no Connection yet,
 *    we fall back to `?`.
 *  - `%#` checks the `IS_SUPERUSER` psql variable (set by upstream's
 *    `is_superuser()` via the connect-time hook). Without a Connection we
 *    default to non-superuser (`>`).
 *  - `%P` outputs `off`/`on`/`abort` to match upstream's literal strings.
 *  - `%i` outputs `primary` / `standby` / `?` (upstream reads the GUC
 *    `in_hot_standby`); when no connection, `?`. The WP-07 spec asked for
 *    "if-state from CondStack" — that conflicts with upstream `%i` and we
 *    follow upstream. `%?` remains a no-op marker in upstream too.
 *  - `%[`/`%]` are upstream's readline non-printing markers. We strip them
 *    (emit nothing) for now; a future WP wiring readline integration can
 *    re-introduce them.
 *  - Backtick command interpolation (`%`\``cmd`\``) is executed synchronously
 *    via `child_process.execSync` on `sh -c <cmd>`. Output is substituted
 *    verbatim minus one trailing newline. Errors print to stderr and yield
 *    an empty substitution — matching upstream's `get_prompt`, which re-runs
 *    the command on every render rather than caching.
 *  - Unknown `%X` escapes pass through as literal `X` (the upstream
 *    `default:` branch). `%w` width is computed from PROMPT1 when present
 *    and consumed by a subsequent PROMPT2 render via the optional
 *    `lastPrompt1Width` field on the context.
 */

import { execSync } from 'node:child_process';

import type { PsqlSettings } from '../types/settings.js';
import type { CondStack, IfState } from '../types/repl.js';
import type { PromptStatus } from '../types/scanner.js';

export type PromptName = 'PROMPT1' | 'PROMPT2' | 'PROMPT3';

/**
 * Test seam for the prompt-level backtick executor. The default
 * implementation calls `execSync(cmd, { shell: '/bin/sh' })`; tests can
 * replace `.current` with a synchronous mock to avoid actually spawning
 * a child. Same pattern as `BACKTICK_EXECUTOR` in `scanner/slash.ts`.
 */
export const PROMPT_BACKTICK_EXECUTOR: {
  current: (cmd: string) => string;
} = {
  current: (cmd: string) =>
    execSync(cmd, {
      shell: '/bin/sh',
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      // Keep prompt rendering responsive — a heavy backtick command should
      // not be able to fill arbitrary memory or hang the prompt forever.
      maxBuffer: 1 << 16,
    }),
};

/**
 * Run a single backtick command and return its stdout, with one trailing
 * newline trimmed. On failure (non-zero exit / spawn error) print the
 * error to stderr and return the empty string so the prompt still renders.
 */
const runPromptBacktick = (cmd: string): string => {
  if (cmd.length === 0) return '';
  try {
    const out = PROMPT_BACKTICK_EXECUTOR.current(cmd);
    return out.endsWith('\n') ? out.slice(0, -1) : out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`psql: error: \\!: ${cmd}: ${msg}\n`);
    return '';
  }
};

export type TransactionState = 'idle' | 'in-block' | 'failed' | 'unknown';
export type PipelineState = 'off' | 'on' | 'aborted';

export type PromptContext = {
  settings: PsqlSettings;
  cond: CondStack;
  /** Scanner state — drives `%R` under PROMPT2. */
  promptStatus: PromptStatus;
  /** Statement line number for `%l`. */
  lineNumber: number;
  /** Transaction status from libpq (`PQtransactionStatus`) — drives `%x`. */
  inTransaction?: TransactionState;
  /** Pipeline mode status — drives `%P`. */
  pipelineState?: PipelineState;
  /**
   * Visible width of the most-recent PROMPT1 render. Set automatically by
   * `renderPrompt` when invoked with `promptName === 'PROMPT1'`. Consumed
   * by `%w` under PROMPT2. Callers may also pass a value in directly.
   */
  lastPrompt1Width?: number;
};

/**
 * Render a prompt by name. Selects the template from
 * `settings.prompt{1,2,3}` and delegates to the escape-walking core.
 */
export const renderPromptByName = (
  name: PromptName,
  ctx: PromptContext,
): string => {
  const template =
    name === 'PROMPT1'
      ? ctx.settings.prompt1
      : name === 'PROMPT2'
        ? ctx.settings.prompt2
        : ctx.settings.prompt3;
  const isPrompt1 = name === 'PROMPT1';
  const out = renderPrompt(template, ctx);
  if (isPrompt1) {
    // Stash the visible width on the context so a subsequent PROMPT2 render
    // sharing this context object can line up with `%w`.
    ctx.lastPrompt1Width = visibleWidth(out);
  }
  return out;
};

/**
 * Render an arbitrary prompt template. Pure function over `(template, ctx)`.
 */
export const renderPrompt = (template: string, ctx: PromptContext): string => {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch !== '%') {
      out += ch;
      i += 1;
      continue;
    }
    // We have `%X`; advance past the `%` and resolve.
    i += 1;
    if (i >= template.length) {
      // Trailing `%` — emit nothing, matches upstream (esc stays true and
      // the loop exits without strlcat).
      break;
    }
    const escape = template[i];
    const { text, consumed } = expandEscape(escape, template, i, ctx);
    out += text;
    i += consumed;
  }
  return out;
};

const expandEscape = (
  escape: string,
  template: string,
  /** Index of `escape` within `template`. */
  start: number,
  ctx: PromptContext,
): { text: string; consumed: number } => {
  const { settings } = ctx;
  const db = settings.db;

  switch (escape) {
    case '%':
      return { text: '%', consumed: 1 };

    case '/':
      // Current database.
      return { text: db ? currentDatabase(ctx) : '', consumed: 1 };

    case '~': {
      // Like %/, but "~" when current_db matches the user's default db.
      // Upstream compares PQdb(pset.db) against PQuser(pset.db) and
      // against $PGDATABASE.
      if (!db) return { text: '', consumed: 1 };
      const cdb = currentDatabase(ctx);
      const user = currentUser(ctx);
      const pgdb = process.env.PGDATABASE;
      if (cdb === user || (pgdb !== undefined && pgdb === cdb)) {
        return { text: '~', consumed: 1 };
      }
      return { text: cdb, consumed: 1 };
    }

    case 'M':
    case 'm':
      return {
        text: db ? hostString(ctx, escape === 'm') : '',
        consumed: 1,
      };

    case '>':
      return { text: db ? portString(ctx) : '', consumed: 1 };

    case 'n':
      return { text: db ? currentUser(ctx) : '', consumed: 1 };

    case 'p': {
      if (!db) return { text: '', consumed: 1 };
      const pid = backendPid(ctx);
      return { text: pid !== null ? String(pid) : '', consumed: 1 };
    }

    case 'P': {
      if (!db) return { text: '', consumed: 1 };
      // Upstream emits "off" / "on" / "abort" (no trailing 'ed').
      const state = ctx.pipelineState ?? 'off';
      const text =
        state === 'on' ? 'on' : state === 'aborted' ? 'abort' : 'off';
      return { text, consumed: 1 };
    }

    case 'i': {
      // Hot-standby indicator. Upstream reads in_hot_standby GUC.
      if (!db) return { text: '', consumed: 1 };
      const hs = parameterStatus(ctx, 'in_hot_standby');
      if (hs === undefined) return { text: '?', consumed: 1 };
      return { text: hs === 'on' ? 'standby' : 'primary', consumed: 1 };
    }

    case 's': {
      // service name from psql var SERVICE (upstream prompt.c).
      const svc = settings.vars.get('SERVICE');
      return { text: svc ?? '', consumed: 1 };
    }

    case 'S': {
      // search_path; `?` when unavailable (older servers or no conn).
      if (!db) return { text: '?', consumed: 1 };
      const sp = parameterStatus(ctx, 'search_path');
      return { text: sp ?? '?', consumed: 1 };
    }

    case 'l':
      return { text: String(ctx.lineNumber), consumed: 1 };

    case 'w': {
      // Whitespace padding the width of the last PROMPT1 render.
      const width = Math.max(0, ctx.lastPrompt1Width ?? 0);
      return { text: db ? ' '.repeat(width) : '', consumed: 1 };
    }

    case 'a':
      // Bell. Upstream falls into default, which is just literal 'a' (no
      // bell handling in get_prompt). The WP-07 spec explicitly asks for
      // ^G though, and emitting BEL is harmless. Honour the spec.
      return { text: '\x07', consumed: 1 };

    case 'R': {
      const text = expandR(ctx);
      return { text, consumed: 1 };
    }

    case 'x': {
      if (!db) return { text: '?', consumed: 1 };
      const tx = ctx.inTransaction ?? 'idle';
      if (tx === 'in-block') return { text: '*', consumed: 1 };
      if (tx === 'failed') return { text: '!', consumed: 1 };
      if (tx === 'unknown') return { text: '?', consumed: 1 };
      return { text: '', consumed: 1 };
    }

    case '#': {
      // Superuser indicator. Upstream calls is_superuser() which checks
      // pset.vars["IS_SUPERUSER"] === "on".
      const isSuper = settings.vars.get('IS_SUPERUSER') === 'on';
      return { text: isSuper ? '#' : '>', consumed: 1 };
    }

    case '?':
      // Reserved by upstream ("not here yet"). Emit nothing.
      return { text: '', consumed: 1 };

    case '[':
    case ']':
      // Readline non-printing markers. Strip — no terminal info embedded.
      return { text: '', consumed: 1 };

    case '`': {
      // Backtick command: read until the matching `` ` `` after the opening
      // backtick, then run the body through `sh -c` and substitute its
      // stdout. Upstream `get_prompt` re-runs the command on every render
      // rather than caching, so we do the same — callers who want caching
      // should stash the rendered prompt themselves.
      const close = template.indexOf('`', start + 1);
      if (close === -1) {
        // Unterminated — consume the rest defensively without spawning.
        return { text: '', consumed: template.length - start };
      }
      const body = template.slice(start + 1, close);
      return { text: runPromptBacktick(body), consumed: close - start + 1 };
    }

    case ':': {
      // Variable interpolation %:name:
      const close = template.indexOf(':', start + 1);
      if (close === -1) {
        return { text: '', consumed: template.length - start };
      }
      const name = template.slice(start + 1, close);
      const val = settings.vars.get(name);
      return { text: val ?? '', consumed: close - start + 1 };
    }

    case '0':
    case '1':
    case '2':
    case '3':
    case '4':
    case '5':
    case '6':
    case '7': {
      // Octal byte value `%nnn`. Upstream uses strtol(p, &p, 8), which
      // greedily consumes 1–3 octal digits.
      let consumed = 1;
      let body = escape;
      while (consumed < 3 && start + consumed < template.length) {
        const next = template[start + consumed];
        if (next >= '0' && next <= '7') {
          body += next;
          consumed += 1;
        } else {
          break;
        }
      }
      const byte = parseInt(body, 8);
      return { text: String.fromCharCode(byte), consumed };
    }

    default:
      // Unknown escape → literal character (matches upstream default:).
      return { text: escape, consumed: 1 };
  }
};

/**
 * Expand `%R`. PROMPT1 reflects the connection / cond-stack / singleline
 * state. PROMPT2 reflects the scanner's promptStatus. PROMPT3 is the COPY
 * indicator and is delegated to the PROMPT2 mapping (upstream falls into
 * the `default` branch and emits nothing — we do the same).
 */
const expandR = (ctx: PromptContext): string => {
  const { promptStatus, cond, settings } = ctx;
  switch (promptStatus) {
    case 'ready': {
      if (!isConditionalActive(cond)) return '@';
      if (!settings.db) return '!';
      if (!settings.singleline) return '=';
      return '^';
    }
    case 'continue':
      return '-';
    case 'comment':
      return '*';
    case 'paren':
      return '(';
    case 'copy':
      // PROMPT3 / COPY path — upstream emits nothing for %R here.
      return '';
    default:
      return '';
  }
};

/**
 * Return `false` if the current `\if` branch is non-active (we're inside a
 * skipped block). Mirrors upstream `conditional_active`. Inactive states are
 * `false`, `else-false`, and `ignored`; everything else (including the
 * sentinel `none` for "no \if active") is treated as active.
 */
const isConditionalActive = (cond: CondStack): boolean => {
  const top = cond.top();
  if (!top) return true;
  const inactive: IfState[] = ['false', 'else-false', 'ignored'];
  return !inactive.includes(top.state);
};

/**
 * Visible width of a rendered prompt — used to seed `%w` on PROMPT2. We
 * subtract ANSI escape sequences and the unicode width is approximated by
 * code-point count (full Unicode width tables live in the printer WP).
 */
const visibleWidth = (s: string): number => {
  // Strip CSI escapes (ESC `[` … letter). Conservative — only trims the
  // common ANSI color form psql emits. Newlines reset the count.
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const lastNl = stripped.lastIndexOf('\n');
  const tail = lastNl === -1 ? stripped : stripped.slice(lastNl + 1);
  // Code-unit count — good enough for ASCII prompts; CJK / surrogate-pair
  // width handling is a printer-WP concern.
  return tail.length;
};

// ---------------------------------------------------------------------------
// Connection accessors.
//
// At WP-07 time, `settings.db` is always null (the Connection wiring lives
// in the startup/connect WP). The helpers below define the contract for
// when `db` is populated: they look at common cached fields, then fall back
// to `parameterStatus()` for GUCs. Each accessor is null-safe; callers
// guard on `settings.db` before calling them.
// ---------------------------------------------------------------------------

type MaybeWithMeta = {
  user?: unknown;
  database?: unknown;
  host?: unknown;
  port?: unknown;
  pid?: unknown;
};

const currentDatabase = (ctx: PromptContext): string => {
  const db = ctx.settings.db;
  if (!db) return '';
  // Prefer a libpq-style accessor if the runtime Connection exposes one;
  // otherwise fall back to the application's GUC view.
  const meta = db as unknown as MaybeWithMeta;
  if (typeof meta.database === 'string' && meta.database.length > 0) {
    return meta.database;
  }
  return parameterStatus(ctx, 'database') ?? '';
};

const currentUser = (ctx: PromptContext): string => {
  const db = ctx.settings.db;
  if (!db) return '';
  const meta = db as unknown as MaybeWithMeta;
  if (typeof meta.user === 'string' && meta.user.length > 0) {
    return meta.user;
  }
  return parameterStatus(ctx, 'session_authorization') ?? '';
};

const hostString = (ctx: PromptContext, short: boolean): string => {
  const db = ctx.settings.db;
  if (!db) return '';
  const meta = db as unknown as MaybeWithMeta;
  const host = typeof meta.host === 'string' ? meta.host : '';
  if (host.length === 0 || host.startsWith('/')) {
    // UNIX socket / unknown — upstream emits "[local]" or "[local:path]".
    if (host.length === 0 || short) return '[local]';
    return `[local:${host}]`;
  }
  if (short) {
    const dot = host.indexOf('.');
    return dot === -1 ? host : host.slice(0, dot);
  }
  return host;
};

const portString = (ctx: PromptContext): string => {
  const db = ctx.settings.db;
  if (!db) return '';
  const meta = db as unknown as MaybeWithMeta;
  if (typeof meta.port === 'number' && Number.isFinite(meta.port)) {
    return String(meta.port);
  }
  if (typeof meta.port === 'string' && meta.port.length > 0) {
    return meta.port;
  }
  return '';
};

const backendPid = (ctx: PromptContext): number | null => {
  const db = ctx.settings.db;
  if (!db) return null;
  const meta = db as unknown as MaybeWithMeta;
  if (typeof meta.pid === 'number' && Number.isFinite(meta.pid)) {
    return meta.pid;
  }
  return null;
};

const parameterStatus = (
  ctx: PromptContext,
  name: string,
): string | undefined => {
  const db = ctx.settings.db;
  if (!db) return undefined;
  try {
    return db.parameterStatus(name);
  } catch {
    return undefined;
  }
};
