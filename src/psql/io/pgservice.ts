/**
 * `pg_service.conf` (connection service file) support.
 *
 * TypeScript port of libpq's `parseServiceInfo` in `src/interfaces/libpq/
 * fe-connect.c`. A service file is an INI-style document with one section
 * per service name; each section's `key=value` pairs map onto libpq
 * connection parameters.
 *
 * Format:
 *
 *   # this is a comment
 *   [servicename]
 *   host=foo.example.com
 *   port=5432
 *   dbname=mydb
 *   user=myuser
 *
 *   [other]
 *   host=bar
 *
 * Resolution order (mirrors libpq):
 *
 *   1. `$PGSERVICEFILE` if set and non-empty
 *   2. `~/.pg_service.conf` (POSIX) / `%APPDATA%\postgresql\.pg_service.conf`
 *      (Windows)
 *   3. `$PGSYSCONFDIR/pg_service.conf`
 *   4. `/etc/pg_service.conf` (POSIX platform-default fallback)
 *
 * Files are stat'd in order; the first existing file wins. (libpq merges
 * service entries across files in load order; we read only the first
 * existing one to match what neonctl users actually rely on. This matches
 * the documented "search path" behaviour.)
 *
 * Keys in a service section are case-sensitive; the section header is the
 * service name (libpq normalises neither). Unknown keys are accepted
 * silently — libpq would also accept them and feed them to `PQconninfoParse`,
 * which is responsible for the recognised-key gate.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type ServiceEntry = Record<string, string>;

const isWindows = process.platform === 'win32';

/**
 * Return the ordered list of candidate `pg_service.conf` paths to try. The
 * caller stops at the first one that exists. Pure function — `env` defaults
 * to `process.env` for ergonomics but can be injected for tests.
 */
export const defaultPgServiceFilePath = (
  env: NodeJS.ProcessEnv = process.env,
): string[] => {
  const out: string[] = [];

  const explicit = env.PGSERVICEFILE;
  if (explicit !== undefined && explicit.length > 0) {
    out.push(explicit);
  }

  // User-level: `~/.pg_service.conf` (POSIX) or
  // `%APPDATA%/postgresql/.pg_service.conf` (Windows). Matches libpq.
  if (isWindows) {
    const appdata = env.APPDATA;
    if (appdata !== undefined && appdata.length > 0) {
      out.push(path.join(appdata, 'postgresql', '.pg_service.conf'));
    }
  } else {
    const home = env.HOME ?? os.homedir();
    if (home.length > 0) {
      out.push(path.join(home, '.pg_service.conf'));
    }
  }

  // System-level: `$PGSYSCONFDIR/pg_service.conf`.
  const sysDir = env.PGSYSCONFDIR;
  if (sysDir !== undefined && sysDir.length > 0) {
    out.push(path.join(sysDir, 'pg_service.conf'));
  }

  // Platform-default system path. libpq's autoconf picks SYSCONFDIR at build
  // time; for a portable TS implementation we use `/etc/pg_service.conf` on
  // POSIX. Windows has no canonical equivalent.
  if (!isWindows) {
    out.push('/etc/pg_service.conf');
  }

  return out;
};

/**
 * Parse the contents of a `pg_service.conf` string into a Map keyed by
 * service name. Exported for tests; production callers should use
 * `loadPgServices` which walks the discovery list.
 *
 * Parser behaviour:
 *   - Lines starting with `#` (after leading whitespace) are comments.
 *   - Blank lines are skipped.
 *   - Section header `[name]` opens a new service; later sections with the
 *     same name OVERRIDE earlier ones within the same file (libpq emits a
 *     warning; we silently override).
 *   - `key=value` lines populate the current section. Leading/trailing
 *     whitespace around `key` and `value` is trimmed; values are NOT quoted
 *     (libpq's parser is line-oriented).
 *   - Lines outside any section header are silently ignored.
 */
export const parsePgServiceContent = (
  content: string,
): Map<string, ServiceEntry> => {
  const services = new Map<string, ServiceEntry>();
  let current: ServiceEntry | undefined;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;

    if (line.startsWith('[')) {
      const close = line.indexOf(']');
      if (close < 0) {
        // Malformed header — libpq aborts the file; we mirror by ending the
        // current section so the bogus line doesn't bleed into it.
        current = undefined;
        continue;
      }
      const name = line.slice(1, close).trim();
      if (name.length === 0) {
        current = undefined;
        continue;
      }
      current = {};
      services.set(name, current);
      continue;
    }

    if (current === undefined) {
      // Stray key=value before any [section] header — libpq treats this as
      // an error; we silently skip so a misformatted file doesn't refuse to
      // resolve services that appear after the noise.
      continue;
    }

    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key.length === 0) continue;
    current[key] = value;
  }

  return services;
};

const readIfExists = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    // Permission / I/O errors silently degrade — libpq treats an unreadable
    // service file the same as a missing one (the connection falls back to
    // other parameter sources).
    return null;
  }
};

/**
 * Discover and parse `pg_service.conf`. Walks the candidate list returned by
 * `defaultPgServiceFilePath`, reading the first existing file.
 *
 * Resolves to an empty Map when no file is found.
 */
export const loadPgServices = async (
  paths?: string[],
): Promise<Map<string, ServiceEntry>> => {
  const candidates = paths ?? defaultPgServiceFilePath();
  for (const p of candidates) {
    const content = await readIfExists(p);
    if (content === null) continue;
    return parsePgServiceContent(content);
  }
  return new Map();
};

/**
 * Look up a service section by name. Returns `undefined` if not present.
 *
 * Service names are case-sensitive (libpq does not normalise).
 */
export const lookupService = (
  services: Map<string, ServiceEntry>,
  name: string,
): ServiceEntry | undefined => services.get(name);
