/**
 * Connection-driven psql variable sync.
 *
 * TypeScript port of `SyncVariables()` in upstream PostgreSQL's
 * `src/bin/psql/command.c`. After every successful connection (the initial
 * connect in `runPsql` and each `\c` reconnect), psql refreshes the set of
 * read-only "connection" variables that scripts interpolate with `:DBNAME`,
 * `:USER`, etc. Without this the names interpolate to their literal text
 * (`:USER` → `:USER`) instead of the live connection facts.
 *
 * The variables synced here mirror upstream's `SyncVariables()`:
 *
 *   - `DBNAME`              — connection database
 *   - `USER`               — connection user
 *   - `HOST`               — host the client connected to (a socket directory
 *                            for a Unix-domain socket — starts with `/`)
 *   - `PORT`               — connection port (stringified)
 *   - `ENCODING`           — client encoding name (the `client_encoding`
 *                            ParameterStatus). The mainloop keeps this in
 *                            sync on later `SET client_encoding`; we seed it
 *                            here so it is correct from the first prompt.
 *   - `SERVER_VERSION_NAME`— the `server_version` ParameterStatus (e.g. `18.4`)
 *   - `SERVER_VERSION_NUM` — the numeric server version (e.g. `180004`),
 *                            stringified from `Connection.serverVersion`
 *
 * The CLIENT version variables (`VERSION` / `VERSION_NAME` / `VERSION_NUM`)
 * are constant for the life of the process and set once at startup — see
 * {@link setStartupVars}.
 */

import type { Connection } from '../types/connection.js';
import type { VarStore } from '../types/variables.js';

/**
 * The connection-target accessors `PgConnection` exposes but the frozen
 * {@link Connection} interface deliberately omits (it surfaces them via the
 * `getConnectionInfo()` accessor / prompt duck-typing instead). We read them
 * through this typed structural view — the same pattern `cmd_connect.ts` uses
 * for the `password` getter — rather than widening the shared interface.
 */
type ConnTarget = {
  database?: unknown;
  user?: unknown;
  host?: unknown;
  port?: unknown;
};

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const asPort = (value: unknown): string | undefined =>
  typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : undefined;

/**
 * Refresh the connection variables (`DBNAME`, `USER`, `HOST`, `PORT`,
 * `ENCODING`, `SERVER_VERSION_NAME`, `SERVER_VERSION_NUM`) from the live
 * connection. Mirrors upstream `SyncVariables()`. Call after a successful
 * initial connect and after each `\c` reconnect.
 *
 * A variable is only set when the connection actually surfaces a value; this
 * leaves any user-set value untouched if the connection cannot report one.
 */
export const syncConnectionVars = (vars: VarStore, conn: Connection): void => {
  const target = conn as unknown as ConnTarget;

  const database = asString(target.database);
  if (database !== undefined) vars.set('DBNAME', database);

  const user = asString(target.user);
  if (user !== undefined) vars.set('USER', user);

  const host = asString(target.host);
  if (host !== undefined) vars.set('HOST', host);

  const port = asPort(target.port);
  if (port !== undefined) vars.set('PORT', port);

  // ENCODING tracks the server's `client_encoding` ParameterStatus. The
  // mainloop refreshes it after each `SET client_encoding`; seed it here so
  // it is populated from the very first prompt (and re-seeded after `\c`).
  const encoding = conn.parameterStatus('client_encoding');
  if (encoding !== undefined) vars.set('ENCODING', encoding);

  const serverVersionName = conn.parameterStatus('server_version');
  if (serverVersionName !== undefined) {
    vars.set('SERVER_VERSION_NAME', serverVersionName);
  }

  // `Connection.serverVersion` is the libpq-style integer (e.g. 180004 for
  // 18.4); 0 means "not yet reported" — skip it so we don't write a bogus 0.
  if (conn.serverVersion > 0) {
    vars.set('SERVER_VERSION_NUM', String(conn.serverVersion));
  }
};

/**
 * Set the constant CLIENT version variables once at startup, mirroring how
 * upstream psql seeds `VERSION` / `VERSION_NAME` / `VERSION_NUM` from its
 * compiled-in `PG_VERSION` / `PG_VERSION_NUM`:
 *
 *   - `VERSION`      — the full banner string (upstream: `PostgreSQL <ver> …`).
 *   - `VERSION_NAME` — the bare version number (upstream: e.g. `18.4`).
 *   - `VERSION_NUM`  — the numeric version (upstream: e.g. `180004`).
 *
 * The embedded psql is not a real PostgreSQL build, so there is no
 * `PG_VERSION` to read. We derive the values from neonctl's own package
 * version (passed in as {@link clientVersion}, e.g. `2.22.0`) so the client
 * identifier is real and traceable to the shipped binary, while keeping
 * upstream's variable *shapes*:
 *
 *   - `VERSION`      → `psql-ts (neonctl) <clientVersion>` — a banner that
 *     names the implementation so users can tell they are on the embedded
 *     TS port, mirroring the startup banner's `psql-ts (neonctl, …)` shape.
 *   - `VERSION_NAME` → `<clientVersion>` (e.g. `2.22.0`).
 *   - `VERSION_NUM`  → the same version mapped into PG's NNMMPP integer form
 *     (`2.22.0` → `22200`) via {@link clientVersionNum}, so a script doing a
 *     numeric `:VERSION_NUM` comparison gets a monotonic integer.
 */
export const setStartupVars = (vars: VarStore, clientVersion: string): void => {
  vars.set('VERSION', `psql-ts (neonctl) ${clientVersion}`);
  vars.set('VERSION_NAME', clientVersion);
  vars.set('VERSION_NUM', String(clientVersionNum(clientVersion)));
};

/**
 * Map a `MAJOR.MINOR.PATCH` semver-style version string into PG's
 * `PG_VERSION_NUM` integer layout (`MAJOR * 10000 + MINOR * 100 + PATCH`,
 * e.g. `2.22.0` → `22200`). Missing components default to 0; a non-numeric
 * leading component yields `0`. Kept deliberately tolerant — the value only
 * needs to be a monotonic integer for `:VERSION_NUM` comparisons.
 */
export const clientVersionNum = (version: string): number => {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  if (!m) return 0;
  const major = parseInt(m[1], 10);
  const minor = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  const patch = m[3] !== undefined ? parseInt(m[3], 10) : 0;
  return major * 10000 + minor * 100 + patch;
};
