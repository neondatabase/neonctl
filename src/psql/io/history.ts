/**
 * psql history file I/O.
 *
 * TypeScript port of the history-handling portion of PostgreSQL's
 * `src/bin/psql/input.c`. Implements the read/append/truncate operations the
 * REPL drives plus the small env-resolution helpers (`PSQL_HISTORY`,
 * `HISTSIZE`).
 *
 * On-disk format follows GNU readline's history file:
 *
 *   - One entry per line, UTF-8.
 *   - Multi-line entries are encoded with the literal escape sequences
 *     `\n` (backslash + n), `\r`, and `\\`. We decode them back to real
 *     newlines / carriage returns / backslashes on load and re-encode on
 *     write. Upstream psql uses an in-memory NL_IN_HISTORY (0x01) marker
 *     that libreadline then translates to the same on-disk form; we skip
 *     the intermediate marker and operate on real strings throughout.
 *   - Lines whose first character is `#` are treated as timestamp / comment
 *     markers (libreadline writes them when `history_write_timestamps` is
 *     set) and silently skipped on load. psql itself never writes them.
 *
 * Intentional deviations from upstream:
 *
 *   - Append-only writes use `fs.promises.appendFile`, which opens the file
 *     with `O_APPEND` on POSIX so concurrent appends from multiple psql
 *     instances do not interleave within a single write call. On Windows
 *     there is a small race window we accept; the alternative (an external
 *     lock file) is not worth the dependency churn.
 *   - `truncateHistory` writes the trimmed history to a sibling temp file
 *     and `rename`s it into place. POSIX `rename(2)` is atomic w.r.t. other
 *     processes observing the path; Windows is best-effort.
 *   - HISTCONTROL comparisons run on the raw (decoded) entry — this matches
 *     bash/readline behaviour where the user's literal input is what gets
 *     deduped, not the escaped on-disk form.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { HistControl } from '../types/settings.js';

/** psql's compiled-in default for HISTSIZE (see `src/bin/psql/settings.h`). */
const DEFAULT_HISTSIZE = 500;

/** Encode a single in-memory entry to the on-disk libreadline form. */
const encodeEntry = (entry: string): string =>
  entry.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');

/**
 * Decode a single on-disk libreadline line back to its in-memory form.
 *
 * Recognised escapes: `\\` → `\`, `\n` → newline, `\r` → CR. Any other
 * `\<x>` sequence is left as-is (matching readline's lenient decoder), so
 * a stray backslash at the end of the file does not eat the next entry.
 */
const decodeEntry = (line: string): string => {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 0x5c /* '\\' */ && i + 1 < line.length) {
      const next = line[i + 1];
      if (next === 'n') {
        out += '\n';
        i++;
        continue;
      }
      if (next === 'r') {
        out += '\r';
        i++;
        continue;
      }
      if (next === '\\') {
        out += '\\';
        i++;
        continue;
      }
    }
    out += line[i];
  }
  return out;
};

/**
 * Return `true` if `entry` should be filtered out under `histcontrol`
 * relative to the most recent entry already in history (`prev`).
 *
 * Mirrors `pg_send_history()`'s filter in `input.c`.
 */
const shouldIgnore = (
  entry: string,
  prev: string | undefined,
  histcontrol: HistControl,
): boolean => {
  const ignoreSpace =
    histcontrol === 'ignorespace' || histcontrol === 'ignoreboth';
  const ignoreDups =
    histcontrol === 'ignoredups' || histcontrol === 'ignoreboth';

  if (ignoreSpace && entry.length > 0 && /^\s/.test(entry)) return true;
  if (ignoreDups && prev !== undefined && prev === entry) return true;
  return false;
};

/**
 * Read a libreadline history file and return entries in chronological
 * order (oldest first). A missing file resolves to `[]` so callers can
 * unconditionally `loadHistory` at startup.
 *
 * Lines beginning with `#` are silently skipped (libreadline timestamp
 * markers; psql itself never writes them but we tolerate them).
 *
 * Other I/O errors (EACCES, EISDIR, …) propagate to the caller.
 */
export const loadHistory = async (filePath: string): Promise<string[]> => {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return [];
    }
    throw err;
  }

  // Strip a single trailing newline so a well-formed file ending in `\n`
  // doesn't produce a phantom empty entry. Don't strip more than one — a
  // blank line in the middle of the file represents an entry that was
  // literally the empty string (rare but possible), and we round-trip it.
  if (raw.endsWith('\n')) raw = raw.slice(0, -1);
  if (raw.length === 0) return [];

  const entries: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('#')) continue;
    entries.push(decodeEntry(line));
  }
  return entries;
};

/**
 * Append a single entry to the history file, subject to HISTCONTROL.
 *
 * Implementation notes:
 *
 *   - On POSIX, `fs.appendFile` opens with `O_APPEND`, which guarantees
 *     each `write(2)` lands at the current end-of-file. A single
 *     encoded entry plus its trailing `\n` is one write, so concurrent
 *     psql instances writing to the same history file never interleave
 *     within an entry. We accept a small race on Windows.
 *   - `ignoredups` consults the *last* entry currently on disk. We read
 *     the tail of the file rather than the whole history to keep this
 *     O(1)-ish for large histories; for simplicity we read everything
 *     when ignoredups is in effect — typical history files are well
 *     under 1 MiB.
 */
export const appendHistory = async (
  filePath: string,
  entry: string,
  histcontrol: HistControl = 'none',
): Promise<void> => {
  if (
    histcontrol === 'ignoredups' ||
    histcontrol === 'ignoreboth' ||
    histcontrol === 'ignorespace'
  ) {
    let prev: string | undefined;
    if (histcontrol === 'ignoredups' || histcontrol === 'ignoreboth') {
      const existing = await loadHistory(filePath);
      prev = existing[existing.length - 1];
    }
    if (shouldIgnore(entry, prev, histcontrol)) return;
  }

  await fs.appendFile(filePath, encodeEntry(entry) + '\n', 'utf8');
};

/**
 * Trim the history file to its last `maxLines` entries.
 *
 * If `maxLines <= 0` the file is removed entirely (matching psql's
 * behaviour when HISTSIZE is set to 0). If the file already fits the
 * cap, it's left untouched. Otherwise we write the kept tail to a
 * sibling temp file and `rename` it into place.
 *
 * `rename(2)` on POSIX is atomic w.r.t. observers of the destination
 * path; on Windows the platform call may briefly fail if another
 * process has the destination open, in which case the error propagates.
 */
export const truncateHistory = async (
  filePath: string,
  maxLines: number,
): Promise<void> => {
  if (maxLines <= 0) {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return;
      }
      throw err;
    }
    return;
  }

  const entries = await loadHistory(filePath);
  if (entries.length <= maxLines) return;

  const kept = entries.slice(entries.length - maxLines);
  const body = kept.map(encodeEntry).join('\n') + '\n';

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.${randomUUID()}.tmp`);

  await fs.writeFile(tmpPath, body, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup; the temp file is harmless but noisy.
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
};

/**
 * Resolve the on-disk history file path psql would use, in order of
 * precedence:
 *
 *   1. `$PSQL_HISTORY` if set and non-empty.
 *   2. On Windows: `%APPDATA%\postgresql\psql_history`.
 *   3. Otherwise: `$HOME/.psql_history` (falling back to `os.homedir()`
 *      if `$HOME` is unset, e.g. in some sandboxes).
 *
 * Pure function — `env` defaults to `process.env` but can be injected
 * for tests.
 */
export const defaultHistoryPath = (
  env: Record<string, string | undefined> = process.env,
): string => {
  const explicit = env.PSQL_HISTORY;
  if (explicit !== undefined && explicit.length > 0) return explicit;

  if (process.platform === 'win32') {
    const appdata = env.APPDATA;
    if (appdata !== undefined && appdata.length > 0) {
      return path.join(appdata, 'postgresql', 'psql_history');
    }
    // Fall through to homedir() if APPDATA isn't set; matches psql's
    // graceful degradation on a minimally-configured Windows session.
  }

  const home = env.HOME ?? os.homedir();
  return path.join(home, '.psql_history');
};

/**
 * Resolve the effective HISTSIZE: the `HISTSIZE` env var (if a
 * non-negative integer) or psql's compiled-in default of 500.
 *
 * Values that fail to parse as a non-negative integer fall back to the
 * default — psql itself ignores malformed HISTSIZE and warns, but at
 * this layer we don't have a logger.
 */
export const resolveHistSize = (
  env: Record<string, string | undefined> = process.env,
): number => {
  const raw = env.HISTSIZE;
  if (raw === undefined || raw === '') return DEFAULT_HISTSIZE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_HISTSIZE;
  return n;
};
