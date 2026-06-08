/**
 * `~/.pgpass` password-file support.
 *
 * TypeScript port of the relevant portion of `src/interfaces/libpq/fe-connect.c`
 * (`passwordFromFile`) plus the path/permission rules described in upstream
 * psql's docs (`doc/src/sgml/libpq.sgml`, "The Password File" chapter).
 *
 * On-disk format:
 *
 *   host:port:database:user:password
 *
 * - One entry per line.
 * - Comments start with `#` and run to the end of the line.
 * - Any field may be `*` to match anything.
 * - A literal `:` or `\` in any field must be escaped with `\` (so a password
 *   containing `:` is written `\:`, a literal `\` becomes `\\`). The escape
 *   applies after the `#` stripping but before field splitting — libpq itself
 *   only honours the escape during field tokenisation.
 *
 * Permission check (POSIX only):
 *
 *   libpq refuses to read a .pgpass with group or world read/write bits set.
 *   The exact check is `(st.st_mode & (S_IRWXG | S_IRWXO))` — i.e. `0o077`
 *   masked against the mode. We mirror that: if any of those bits are set we
 *   skip the file and emit a single warning to stderr. Windows skips the check
 *   entirely (libpq does the same — `geteuid` / `S_IRWXG` aren't portable).
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type PgPassEntry = {
  /** Hostname to match, or `*` for any. */
  host: string;
  /** Port to match (string form), or `*` for any. */
  port: string;
  /** Database name to match, or `*` for any. */
  database: string;
  /** User name to match, or `*` for any. */
  user: string;
  /** The password to return on a match. */
  password: string;
};

export type PgPassLookupTarget = {
  host: string;
  port: number;
  database: string;
  user: string;
};

const isWindows = process.platform === 'win32';

/**
 * Return the default `.pgpass` path:
 *
 *   - `$PGPASSFILE` if set and non-empty
 *   - `%APPDATA%\postgresql\pgpass.conf` on Windows
 *   - `$HOME/.pgpass` (falling back to `os.homedir()`) otherwise
 *
 * Pure function — `env` defaults to `process.env` but can be injected for
 * tests.
 */
export const defaultPgPassPath = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const explicit = env.PGPASSFILE;
  if (explicit !== undefined && explicit.length > 0) return explicit;

  if (isWindows) {
    const appdata = env.APPDATA;
    if (appdata !== undefined && appdata.length > 0) {
      return path.join(appdata, 'postgresql', 'pgpass.conf');
    }
    // Fall through to homedir() if APPDATA isn't set — degrade gracefully on
    // a minimally configured Windows session.
  }

  const home = env.HOME ?? os.homedir();
  return path.join(home, '.pgpass');
};

/**
 * Split a `.pgpass` line into its five fields, respecting `\:` and `\\`
 * escapes. Returns `null` for lines that don't yield exactly five fields
 * (malformed entries are silently ignored, matching libpq).
 *
 * Escape semantics (mirroring libpq's `passwordFromFile`):
 *   - `\X` for any X consumes the backslash and emits X literally; the only
 *     escapes intended for `.pgpass` are `\:` (literal colon) and `\\`
 *     (literal backslash), but libpq's decoder is lenient.
 *   - A trailing backslash at end-of-line is dropped.
 */
/** Un-escape `\X` → `X` (a trailing lone backslash is kept). */
const decodeBackslashes = (s: string): string => {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      out += s[i + 1];
      i += 1;
      continue;
    }
    out += s[i];
  }
  return out;
};

const splitLine = (line: string): PgPassEntry | null => {
  // Split on UN-escaped `:` only, PRESERVING backslashes inside each field.
  // The match fields (host/port/database/user) are kept RAW so the wildcard
  // test can distinguish a bare `*` (wildcard) from `\*` (literal `*`) — see
  // fieldMatches / review item #21. libpq does the same: its wildcard check
  // is `strcmp(rawtoken, "*")`, and unescaping happens only during the
  // char-by-char comparison. The password is the returned secret, so it is
  // fully decoded here.
  const fields: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      current += '\\' + line[i + 1];
      i += 1;
      continue;
    }
    if (ch === ':') {
      fields.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  fields.push(current);
  if (fields.length !== 5) return null;
  return {
    host: fields[0],
    port: fields[1],
    database: fields[2],
    user: fields[3],
    password: decodeBackslashes(fields[4]),
  };
};

/**
 * Read and parse a `.pgpass` file. Resolves to `[]` for:
 *
 *   - missing file (ENOENT / ENOTDIR)
 *   - empty file
 *   - permission gate failure on POSIX (a warning is written to `stderr`)
 *
 * Other I/O errors (EACCES on a directory we can stat, EIO, …) also resolve
 * to `[]` since libpq treats `.pgpass` as best-effort: a missing or
 * unreadable file just falls through to the next password source.
 */
export const loadPgPass = async (
  filePath?: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    stderr?: NodeJS.WritableStream;
  },
): Promise<PgPassEntry[]> => {
  const env = opts?.env ?? process.env;
  const stderr = opts?.stderr ?? process.stderr;
  const resolved = filePath ?? defaultPgPassPath(env);

  // Stat the file first so we can do the permission check before opening it.
  // If it doesn't exist, bail out silently.
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    return [];
  }

  if (!stat.isFile()) return [];

  if (!isWindows && (stat.mode & 0o077) !== 0) {
    stderr.write(
      `WARNING: password file "${resolved}" has group or world access; permissions should be u=rw (0600) or less\n`,
    );
    return [];
  }

  let raw: string;
  try {
    raw = await fs.readFile(resolved, 'utf8');
  } catch {
    return [];
  }

  const entries: PgPassEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/^\s+/, '');
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) continue;
    const entry = splitLine(trimmed);
    if (entry !== null) entries.push(entry);
  }
  return entries;
};

/**
 * Match a single field. `*` matches anything; otherwise an exact comparison.
 */
const fieldMatches = (pattern: string, value: string): boolean =>
  // A bare `*` is the wildcard; `\*` decodes to a LITERAL `*` (review #21).
  pattern === '*' || decodeBackslashes(pattern) === value;

/**
 * Look up a password entry for the given `target`. Returns the first matching
 * entry's password, or `undefined` if nothing matches.
 *
 * Match semantics mirror libpq:
 *   - Fields are compared exactly (no wildcards beyond `*`).
 *   - `port` is compared as a string against the target's numeric port.
 *   - Entries are scanned top-to-bottom; the first match wins (so callers
 *     should write specific entries before generic ones).
 */
export const lookupPgPass = (
  entries: readonly PgPassEntry[],
  target: PgPassLookupTarget,
): string | undefined => {
  const portStr = String(target.port);
  for (const e of entries) {
    if (!fieldMatches(e.host, target.host)) continue;
    if (!fieldMatches(e.port, portStr)) continue;
    if (!fieldMatches(e.database, target.database)) continue;
    if (!fieldMatches(e.user, target.user)) continue;
    // The password field is returned literally (already decoded by
    // splitLine). It may be empty — libpq still treats that as "found a
    // match"; we mirror that.
    return e.password;
  }
  return undefined;
};
