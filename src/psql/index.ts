import type { ConnectOptions, RequireAuthMethod } from './types/connection.js';
import type { REPLContext, Stdio } from './types/repl.js';
import type { StartupAction } from './core/startup.js';

import { PgConnection } from './wire/connection.js';
import { applyEnvOverrides, defaultSettings } from './core/settings.js';
import { createVarStore } from './core/variables.js';
import { syncConnectionVars } from './core/syncVars.js';
import { defaultRegistry } from './command/dispatch.js';
import { createCondStack } from './command/cmd_cond.js';
import {
  runMainLoop,
  EXIT_BADCONN,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  EXIT_USER,
} from './core/mainloop.js';
import { applyStartupArgs, parseStartupArgs } from './core/startup.js';
import { executeInputString, loadPsqlrc } from './io/psqlrc.js';
import { loadPgPass } from './io/pgpass.js';
import { loadPgServices } from './io/pgservice.js';
import { promises as fs, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Embedded TypeScript psql entrypoint.
 *
 * Argv shape mirrors the legacy native-psql call site:
 *   argv[0] = connection URI (postgresql://user:pw@host:port/db?sslmode=...)
 *             OR an empty string `''` when the caller provides the
 *             connection target via libpq flags (-h/-p/-U/-d) and/or PG*
 *             env. The downstream layered resolver picks those up just like
 *             upstream psql does.
 *   argv[1..] = forwarded psql args (parsed by `parseStartupArgs`).
 */
export const runPsql = async (
  argv: string[],
  stdio: Stdio = {},
): Promise<number> => {
  const stdin = stdio.stdin ?? process.stdin;
  const stdout = stdio.stdout ?? process.stdout;
  const stderr = stdio.stderr ?? process.stderr;

  const connectionUri = argv[0] ?? '';

  // Parse argv[0] in one of three shapes:
  //   - URI scheme (`postgres://…` / `postgresql://…`): the URI-partial
  //     parser handles authority, query, and `?service=…`.
  //   - libpq conninfo string (`key=value …`, no scheme): `parseConninfo`
  //     extracts each known key (including `service`).
  //   - Bare database name (e.g. `mydb`): no parsing; the rest of the
  //     resolver picks up host/port/user/etc. from env/pgpass/service/
  //     defaults.
  //
  // `looksLikeConnectionString` (libpq parity: `recognized_connection_
  // string()`) decides between the first two and the third.
  //
  // When `connectionUri` is empty (the standalone-psql shim case), we
  // skip parsing entirely and rely on libpq flags + env to populate the
  // ConnectOptions layers.
  let uriPartial: Partial<ConnectOptions> = {};
  let uriService: string | undefined;
  if (connectionUri !== '' && looksLikeConnectionString(connectionUri)) {
    try {
      if (
        connectionUri.startsWith('postgres://') ||
        connectionUri.startsWith('postgresql://')
      ) {
        uriPartial = parseConnectionUriPartial(connectionUri);
        uriService = parseConnectionUriService(connectionUri);
      } else {
        // Bare `key=value …` conninfo string. `parseConninfo` parks the
        // service name on a private `_service` staging slot (it's not
        // part of ConnectOptions); pull it out so the layered resolver
        // can look it up.
        const parsed = parseConninfo(
          connectionUri,
        ) as Partial<ConnectOptions> & {
          _service?: string;
        };
        if (typeof parsed._service === 'string' && parsed._service.length > 0) {
          uriService = parsed._service;
        }
        delete parsed._service;
        uriPartial = parsed;
      }
    } catch (err) {
      stderr.write(`psql: error: ${(err as Error).message}\n`);
      return EXIT_BADCONN;
    }
  }

  // Parse psql args (argv[1..]). argv[0] is the connection URI consumed above.
  const parsed = parseStartupArgs(argv.slice(1));
  if ('kind' in parsed) {
    if (parsed.kind === 'help' || parsed.kind === 'version') {
      stdout.write(parsed.message);
      if (!parsed.message.endsWith('\n')) stdout.write('\n');
      return EXIT_SUCCESS;
    }
    stderr.write(`psql: error: ${parsed.message}\n`);
    return EXIT_FAILURE;
  }

  const vars = createVarStore();
  const settings = defaultSettings(vars);
  applyEnvOverrides(settings, process.env);

  // Track interactive-ness from the actual stdin we'll read.
  settings.notty = !(stdin as NodeJS.ReadStream).isTTY;

  // Resolve external configuration sources (pgpass, pg_service.conf) before
  // running the layered merge. `loadPgPass` always degrades silently to
  // an empty result. `loadPgServices` only errors when the user named a
  // missing file via `$PGSERVICEFILE` (libpq parity for `006_service.pl`);
  // bubble that out as a connection error.
  const pgpassEntries = await loadPgPass(undefined, {
    env: process.env,
    stderr,
  });
  let services;
  try {
    services = await loadPgServices();
  } catch (err) {
    stderr.write(`psql: error: ${(err as Error).message}\n`);
    return EXIT_BADCONN;
  }

  let resolved;
  try {
    resolved = applyStartupArgs(parsed, settings, undefined, {
      env: process.env,
      uriPartial,
      serviceName: uriService,
      pgpassEntries,
      services,
    });
  } catch (err) {
    // `resolveLayeredConnect` throws on unknown service name (libpq
    // parity). Surface as a connection-setup error and bail.
    stderr.write(`psql: error: ${(err as Error).message}\n`);
    return EXIT_BADCONN;
  }
  const { connect: connectOpts, preActions } = resolved;

  let connection: PgConnection;
  try {
    connection = await PgConnection.connect(connectOpts);
  } catch (err) {
    const e = err as { message?: string; code?: string };
    stderr.write(
      `psql: error: connection to server failed: ${e.message ?? String(err)}\n`,
    );
    return EXIT_BADCONN;
  }

  settings.db = connection;

  // Mirror upstream psql's SyncVariables(): populate the connection-driven
  // psql vars (DBNAME/USER/HOST/PORT/ENCODING/SERVER_VERSION_*) so scripts
  // can interpolate `:DBNAME`, `:USER`, etc. from the first prompt onward.
  syncConnectionVars(settings.vars, connection);

  const registry = defaultRegistry();
  const cond = createCondStack();

  const ctx: REPLContext = {
    settings,
    registry,
    cond,
    stdin,
    stdout,
    stderr,
  };

  try {
    // Startup banner — mirrors upstream psql's
    //   psql (<client>, server <server>)
    //   SSL connection (protocol: …, cipher: …)
    //   Type "help" for help.
    // Suppressed in quiet mode and when stdin isn't a TTY (scripted use).
    if (!settings.quiet && !settings.notty && preActions.length === 0) {
      writeStartupBanner(connection, stdout);
    }

    // Run .psqlrc unless -X was specified.
    await loadPsqlrc(ctx, { skip: parsed.noPsqlrc, env: process.env });

    // If the user supplied -c / -f actions, execute them sequentially and
    // exit (mirrors upstream psql behaviour). Otherwise, fall through to
    // the REPL.
    if (preActions.length > 0) {
      return await runPreActions(ctx, preActions, parsed.singleTransaction);
    }

    return await runMainLoop(ctx);
  } finally {
    try {
      await connection.close();
    } catch {
      // ignore close errors
    }
  }
};

/**
 * Execute the ordered list of `-c` / `-f` actions and return the upstream
 * psql exit code.
 *
 * Upstream `process_psqlrc_and_targets()` (in `startup.c`) plus the
 * dispatcher in `MainLoop()` cooperate to give each switch one of three
 * outcomes:
 *
 *   - `-c "SQL or \backslash"`:
 *       * a client-side failure (e.g. bad `\copy`) marks the SWITCH itself
 *         as failed → the overall exit code is non-zero, even when
 *         ON_ERROR_STOP is off and the transaction commits.
 *       * a server-side failure follows the same rule.
 *
 *   - `-f file`:
 *       * `process_file()` returns a success status by default, so a
 *         failing statement inside the file does NOT bubble up to the
 *         outer exit code (without ON_ERROR_STOP). Only an I/O failure
 *         opening the file flips the switch status.
 *
 *   - `--single-transaction`:
 *       * before the FIRST action, issue `BEGIN`. After the LAST action,
 *         issue `COMMIT` (success) or `ROLLBACK` (when ON_ERROR_STOP fired
 *         and we stopped early).
 *       * Without ON_ERROR_STOP, the transaction commits even when some
 *         individual statements failed — the failing statements only
 *         influence the exit code (see the `-c` / `-f` distinction above).
 */
const runPreActions = async (
  ctx: REPLContext,
  preActions: readonly StartupAction[],
  singleTransaction: boolean,
): Promise<number> => {
  const { settings, stderr } = ctx;
  let status: number = EXIT_SUCCESS;
  let beganTransaction = false;
  let earlyStopOnError = false;
  let connectionLost = false;

  // --single-transaction: wrap the entire batch in BEGIN ... COMMIT/ROLLBACK.
  // We do this with `db.execSimple` directly so the wrapper does not itself
  // count as a "failed switch" for exit-code purposes.
  if (singleTransaction && settings.db) {
    try {
      await settings.db.execSimple('BEGIN');
      beganTransaction = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr.write(`psql: error: could not begin transaction: ${msg}\n`);
      return EXIT_FAILURE;
    }
  }

  for (const action of preActions) {
    if (connectionLost) break;
    if (action.kind === 'command') {
      let outcome;
      try {
        outcome = await executeInputString(action.sql, ctx, { print: true });
      } catch (err) {
        // Defensive: executeInputString shouldn't throw, but if a downstream
        // command bubbles an exception we still want to surface it as a
        // failed switch rather than crashing.
        const msg = err instanceof Error ? err.message : String(err);
        stderr.write(`psql: ERROR:  ${msg}\n`);
        status = EXIT_USER;
        if (settings.onErrorStop) {
          earlyStopOnError = true;
          break;
        }
        continue;
      }
      if (outcome.connectionLost) {
        connectionLost = true;
        status = EXIT_BADCONN;
        break;
      }
      // For `-c`: any failure (per-statement or stop-on-error) flips the
      // outer exit code. The contained `\copy` errors are already on stderr.
      if (outcome.hadError || outcome.stoppedOnError) {
        status = EXIT_USER;
      }
      if (outcome.stoppedOnError) {
        earlyStopOnError = true;
        break;
      }
    } else {
      // -f file: I/O failure (missing file, permission denied) is a hard
      // EXIT_FAILURE on the switch. Per-statement failures inside the file
      // are SWALLOWED for exit-code purposes (mirrors `process_file()` in
      // upstream, which only escalates to a stop when ON_ERROR_STOP fires).
      let contents: string;
      try {
        contents = await fs.readFile(action.path, 'utf8');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stderr.write(`psql: error: ${msg}\n`);
        status = EXIT_FAILURE;
        if (settings.onErrorStop) {
          earlyStopOnError = true;
          break;
        }
        continue;
      }
      let outcome;
      try {
        outcome = await executeInputString(contents, ctx, { print: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stderr.write(`psql: ERROR:  ${msg}\n`);
        status = EXIT_USER;
        if (settings.onErrorStop) {
          earlyStopOnError = true;
          break;
        }
        continue;
      }
      if (outcome.connectionLost) {
        connectionLost = true;
        status = EXIT_BADCONN;
        break;
      }
      if (outcome.stoppedOnError) {
        status = EXIT_USER;
        earlyStopOnError = true;
        break;
      }
      // Per-statement errors inside the file do NOT propagate to the outer
      // exit code (matches upstream `process_file` returning success).
    }
  }

  // Wrap up the single-transaction envelope. If we stopped early on error
  // and ON_ERROR_STOP fired, roll back. Otherwise commit — upstream commits
  // even when individual statements failed without ON_ERROR_STOP.
  if (beganTransaction && settings.db && !connectionLost) {
    const closing = earlyStopOnError ? 'ROLLBACK' : 'COMMIT';
    try {
      await settings.db.execSimple(closing);
    } catch (err) {
      // If COMMIT fails the data is gone; surface it but don't override an
      // existing error status. If we tried to COMMIT cleanly and that
      // failed, escalate to EXIT_FAILURE so the caller knows the batch
      // didn't go through.
      const msg = err instanceof Error ? err.message : String(err);
      stderr.write(`psql: error: ${closing} failed: ${msg}\n`);
      if (status === EXIT_SUCCESS) status = EXIT_FAILURE;
    }
  }

  return status;
};

const writeStartupBanner = (
  connection: PgConnection,
  out: NodeJS.WritableStream,
): void => {
  const serverVersion =
    connection.parameterStatus('server_version') ?? 'unknown';
  // Client identifier. Matches upstream's `psql (18.4, server X.Y)` shape
  // but signals that this is the embedded TS implementation so users can tell
  // when they're on the fallback path.
  out.write(`psql-ts (neonctl, server ${serverVersion})\n`);

  const tls = connection.getTlsInfo();
  if (tls) {
    const parts = [
      `protocol: ${tls.protocol}`,
      `cipher: ${tls.cipher}`,
      `compression: ${tls.compression}`,
    ];
    if (tls.alpn) parts.push(`ALPN: ${tls.alpn}`);
    out.write(`SSL connection (${parts.join(', ')})\n`);
  }

  out.write('Type "help" for help.\n\n');
};

type RawUri = {
  user?: string;
  password?: string;
  host?: string;
  port?: string;
  /**
   * Authority-side multi-host tuples (`h1:5432,h2,h3:5434`). Empty unless the
   * authority contained one or more commas. The single-host `host` / `port`
   * fields above remain populated with the FIRST entry so existing
   * single-host callers see no surface change.
   */
  hosts?: { host: string; port?: string }[];
  database?: string;
  query: Map<string, string>;
};

// Recognized libpq connection parameter keywords (subset matching
// https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-PARAMKEYWORDS).
// We don't necessarily honor every value (e.g. hostaddr, krbsrvname), but we
// recognize them as valid keys so callers don't get a spurious "unknown key"
// rejection for a libpq-spec key they expect to work.
const KNOWN_QUERY_KEYS = new Set([
  'host',
  'hostaddr',
  'port',
  'dbname',
  'user',
  'password',
  'passfile',
  'channel_binding',
  'require_auth',
  'connect_timeout',
  'client_encoding',
  'options',
  'application_name',
  'fallback_application_name',
  'keepalives',
  'keepalives_idle',
  'keepalives_interval',
  'keepalives_count',
  'sslmode',
  'sslnegotiation',
  'sslcompression',
  'sslcert',
  'sslkey',
  'sslcertmode',
  'sslrootcert',
  'sslcrl',
  'sslcrldir',
  'sslkeylogfile',
  'sslsni',
  'requirepeer',
  'ssl_min_protocol_version',
  'ssl_max_protocol_version',
  'krbsrvname',
  'gsslib',
  'gssencmode',
  'service',
  'target_session_attrs',
  'load_balance_hosts',
  'replication',
]);

/**
 * Tokenize a postgres connection URI into raw components.
 *
 * Hand-rolled rather than using `new URL()` because libpq accepts shapes
 * the WHATWG URL parser rejects, e.g. `postgresql://user@` (userinfo with
 * no host), `postgres://:12345/` (port-only), `postgres://uri-user@/db`
 * (userinfo with empty host). The upstream conformance suite in
 * `src/interfaces/libpq/t/001_uri.pl` exercises these forms.
 */
const tokenizeConnectionUri = (uri: string): RawUri => {
  // Strip scheme. Only postgres:// and postgresql:// are accepted; libpq
  // rejects everything else with a "missing schema" error.
  let rest: string;
  if (uri.startsWith('postgresql://')) {
    rest = uri.slice('postgresql://'.length);
  } else if (uri.startsWith('postgres://')) {
    rest = uri.slice('postgres://'.length);
  } else {
    throw new Error(`unsupported scheme in URI: ${uri}`);
  }

  // Split off query string.
  let query = '';
  const qIdx = rest.indexOf('?');
  if (qIdx >= 0) {
    query = rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
  }

  // Split off path (database).
  let database: string | undefined;
  const pIdx = rest.indexOf('/');
  if (pIdx >= 0) {
    const pathRaw = rest.slice(pIdx + 1);
    database = pathRaw === '' ? undefined : decodePercent(pathRaw);
    rest = rest.slice(0, pIdx);
  }

  // What's left is the authority: [userinfo@][host[:port]]
  let userinfo: string | undefined;
  const atIdx = rest.lastIndexOf('@');
  if (atIdx >= 0) {
    userinfo = rest.slice(0, atIdx);
    rest = rest.slice(atIdx + 1);
  }

  let user: string | undefined;
  let password: string | undefined;
  if (userinfo !== undefined) {
    const colon = userinfo.indexOf(':');
    if (colon >= 0) {
      user = decodePercent(userinfo.slice(0, colon));
      password = decodePercent(userinfo.slice(colon + 1));
    } else {
      user = decodePercent(userinfo);
    }
  }

  // hostport: either [ipv6]:port, [ipv6], host:port, or host. With multi-host
  // (libpq 10+), the authority may be a comma-separated list:
  //   `h1:5432,h2,[::1]:5433`
  // We split on commas at the top level (i.e. not inside `[...]` IPv6
  // brackets) and parse each segment using the single-host grammar.
  const tuples = splitAuthorityTuples(rest, uri);

  let host: string | undefined;
  let port: string | undefined;
  const hosts: { host: string; port?: string }[] = [];
  for (const tuple of tuples) {
    const parsed = parseAuthorityTuple(tuple, uri);
    if (parsed.host !== undefined) {
      hosts.push({ host: parsed.host, port: parsed.port });
    }
  }
  if (hosts.length > 0) {
    host = hosts[0].host;
    port = hosts[0].port;
  }

  const queryMap = parseQuery(query);

  return {
    user,
    password,
    host,
    port,
    ...(hosts.length > 1 ? { hosts } : {}),
    database,
    query: queryMap,
  };
};

/**
 * Split a multi-host authority string into one tuple per top-level comma.
 * IPv6 bracket regions are atomic — commas inside `[…]` don't split.
 *
 * Examples:
 *   `h1:5432,h2,h3:5434`         -> ['h1:5432','h2','h3:5434']
 *   `[::1]:5432,[2001:db8::1]`   -> ['[::1]:5432','[2001:db8::1]']
 *   `h1`                          -> ['h1']
 *   ``                            -> ['']    (single empty tuple — caller may
 *                                              treat as no-host)
 */
const splitAuthorityTuples = (rest: string, uri: string): string[] => {
  if (rest === '') return [''];
  const tuples: string[] = [];
  let start = 0;
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === '[') {
      const closeIdx = rest.indexOf(']', i);
      if (closeIdx < 0) {
        throw new Error(`missing matching "]" in IPv6 host address: ${uri}`);
      }
      i = closeIdx + 1;
      continue;
    }
    if (ch === ',') {
      tuples.push(rest.slice(start, i));
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  tuples.push(rest.slice(start));
  return tuples;
};

const parseAuthorityTuple = (
  tuple: string,
  uri: string,
): { host?: string; port?: string } => {
  if (tuple === '') return {};
  if (tuple.startsWith('[')) {
    const closeIdx = tuple.indexOf(']');
    if (closeIdx < 0) {
      throw new Error(`missing matching "]" in IPv6 host address: ${uri}`);
    }
    const host = tuple.slice(1, closeIdx);
    if (host === '') {
      throw new Error(`IPv6 host address may not be empty: ${uri}`);
    }
    const after = tuple.slice(closeIdx + 1);
    if (after === '') return { host };
    if (after.startsWith(':')) {
      return { host, port: after.slice(1) };
    }
    throw new Error(
      `unexpected characters after IPv6 host address in URI: ${uri}`,
    );
  }
  const colon = tuple.indexOf(':');
  if (colon >= 0) {
    return {
      host: decodePercent(tuple.slice(0, colon)),
      port: tuple.slice(colon + 1),
    };
  }
  return { host: decodePercent(tuple) };
};

const parseQuery = (raw: string): Map<string, string> => {
  const out = new Map<string, string>();
  if (raw === '') return out;
  for (const segment of raw.split('&')) {
    if (segment === '') continue;
    const eq = segment.indexOf('=');
    if (eq < 0) {
      // libpq: every query parameter must be `key=value`. Bare keys (no `=`)
      // are rejected. Matches the upstream 001_uri.pl `?zzz` and
      // `?value1&value2` cases.
      throw new Error(
        `missing "=" after "${segment.trim()}" in connection info string`,
      );
    }
    const keyRaw = segment.slice(0, eq);
    const valueRaw = segment.slice(eq + 1);
    // libpq rejects an extra `=` in either key or value; matches the
    // `?key=key=value` upstream case.
    if (valueRaw.includes('=')) {
      throw new Error(
        `extra "=" in query parameter "${decodePercent(keyRaw).trim()}"`,
      );
    }
    const key = decodePercent(keyRaw).trim();
    const value = decodePercent(valueRaw).trim();
    if (key === '') continue;
    if (!KNOWN_QUERY_KEYS.has(key)) {
      throw new Error(`invalid URI query parameter: "${key}"`);
    }
    out.set(key, value);
  }
  return out;
};

/**
 * Percent-decode a URI component. libpq strictly validates percent-encoding:
 *   - `%XX` must be two hex digits
 *   - bare `%` or `%X` is invalid
 *   - `%00` is forbidden (NUL bytes can't appear in connection params)
 *
 * `decodeURIComponent` throws URIError on malformed escapes — we surface that
 * as a clear Error. It accepts `%00` (returns `\0`); we explicitly reject.
 */
const decodePercent = (s: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(s);
  } catch {
    throw new Error(`invalid percent-encoded token in URI: ${s}`);
  }
  if (decoded.includes('\x00')) {
    throw new Error(`forbidden NUL byte (%00) in URI: ${s}`);
  }
  return decoded;
};

export const parseConnectionUri = (uri: string): ConnectOptions => {
  const raw = tokenizeConnectionUri(uri);

  // libpq-style: query string can override authority components.
  const queryUser = raw.query.get('user');
  const queryPassword = raw.query.get('password');
  const queryPort = raw.query.get('port');
  const queryDbname = raw.query.get('dbname');
  const queryHost = raw.query.get('host');

  // Multi-host: either from the authority (`h1,h2,h3:5434`) or from
  // `?host=h1,h2,h3&port=5432,5433,5434`. Query-string overrides authority
  // (matching libpq: query params take precedence over URI structural
  // components). Both `host=` and `port=` lists must be the same length OR
  // a single value (broadcast).
  const hostsTuples = computeHostsTuples({
    rawHost: raw.host,
    rawPort: raw.port,
    rawAuthorityHosts: raw.hosts,
    queryHost,
    queryPort,
  });

  // Single-host fallbacks (preserve current behaviour for the `host` / `port`
  // surface — the wire layer prefers `hosts` when set).
  const host =
    hostsTuples.length > 0 && hostsTuples[0].host !== ''
      ? hostsTuples[0].host
      : 'localhost';
  const port = hostsTuples.length > 0 ? hostsTuples[0].port : 5432;

  const user =
    queryUser !== undefined && queryUser !== ''
      ? queryUser
      : raw.user !== undefined && raw.user !== ''
        ? raw.user
        : (process.env.USER ?? '');
  const password = queryPassword ?? raw.password;
  const database = queryDbname ?? raw.database ?? user;

  let ssl = normalizeSslMode(raw.query.get('sslmode') ?? null);
  const channelBinding = normalizeChannelBinding(
    raw.query.get('channel_binding') ?? null,
  );
  // GSSAPI is unsupported (no native Kerberos dep); validate+reject require.
  validateGssEncMode(raw.query.get('gssencmode') ?? null);

  const options = raw.query.get('options');
  // Match upstream psql: default `application_name` to `'psql'` so users see
  // the expected value in `pg_stat_activity`. The neonctl-specific identifier
  // is still discoverable via the User-Agent the protocol layer sends.
  const applicationName = raw.query.get('application_name') ?? 'psql';
  const replication = normalizeReplication(
    raw.query.get('replication') ?? null,
  );
  const targetSessionAttrs = normalizeTargetSessionAttrs(
    raw.query.get('target_session_attrs') ?? null,
  );
  const loadBalanceHosts = normalizeLoadBalanceHosts(
    raw.query.get('load_balance_hosts') ?? null,
  );

  // libpq PEM file paths. Empty string is treated as "not set" so a URI
  // like `?sslcert=` doesn't surface as an attempt to load `""` from disk.
  const sslcert = nonEmpty(raw.query.get('sslcert'));
  const sslkey = nonEmpty(raw.query.get('sslkey'));
  const sslcertmode = normalizeSslCertMode(
    raw.query.get('sslcertmode') ?? null,
  );
  const sslnegotiation = normalizeSslNegotiation(
    raw.query.get('sslnegotiation') ?? null,
  );
  const sslrootcert = nonEmpty(raw.query.get('sslrootcert'));
  const sslcrl = nonEmpty(raw.query.get('sslcrl'));
  const sslcrldir = nonEmpty(raw.query.get('sslcrldir'));
  const sslkeylogfile = nonEmpty(raw.query.get('sslkeylogfile'));

  // libpq sslsni / keepalives toggles (0/1) + keepalives_idle (seconds) +
  // requirepeer (OS user, validated but not enforceable in Node).
  const sslsni = parseLibpqBool(nonEmpty(raw.query.get('sslsni')));
  const keepalives = parseLibpqBool(nonEmpty(raw.query.get('keepalives')));
  const keepalivesIdle = parseKeepalivesIdle(
    nonEmpty(raw.query.get('keepalives_idle')),
  );
  const requirepeer = nonEmpty(raw.query.get('requirepeer'));

  // libpq: `sslrootcert=system` raises the effective sslmode to verify-full.
  // verify-full is the strongest mode, so this only ever raises it.
  if (sslrootcert === 'system' && ssl !== 'verify-full') {
    ssl = 'verify-full';
  }

  // libpq `hostaddr`: a fixed IP that bypasses DNS while `host` still drives
  // TLS SNI / cert verification. Empty string is "not set".
  const hostaddr = nonEmpty(raw.query.get('hostaddr'));
  const sslMinProtocolVersion = normalizeTlsProtocolVersion(
    nonEmpty(raw.query.get('ssl_min_protocol_version')),
    'ssl_min_protocol_version',
  );
  const sslMaxProtocolVersion = normalizeTlsProtocolVersion(
    nonEmpty(raw.query.get('ssl_max_protocol_version')),
    'ssl_max_protocol_version',
  );
  assertTlsProtocolRange(sslMinProtocolVersion, sslMaxProtocolVersion);
  assertTlsMaxProtocolSupported(sslMaxProtocolVersion);
  // libpq rejects `sslnegotiation=direct` paired with a weak sslmode. The URI
  // surface always resolves a concrete `ssl` (defaulting to 'prefer'), so the
  // check is authoritative here.
  assertSslNegotiationModeCompatible(ssl, sslnegotiation);

  return {
    host,
    port,
    user,
    password,
    database,
    ssl,
    channelBinding,
    applicationName,
    options,
    ...(sslnegotiation !== undefined ? { sslnegotiation } : {}),
    ...(hostaddr !== undefined ? { hostaddr } : {}),
    ...(replication !== undefined ? { replication } : {}),
    ...(hostsTuples.length > 1
      ? { hosts: hostsTuples.map((t) => ({ host: t.host, port: t.port })) }
      : {}),
    ...(targetSessionAttrs !== undefined ? { targetSessionAttrs } : {}),
    ...(loadBalanceHosts !== undefined ? { loadBalanceHosts } : {}),
    ...(sslcert !== undefined ? { sslcert } : {}),
    ...(sslkey !== undefined ? { sslkey } : {}),
    ...(sslcertmode !== undefined ? { sslcertmode } : {}),
    ...(sslrootcert !== undefined ? { sslrootcert } : {}),
    ...(sslcrl !== undefined ? { sslcrl } : {}),
    ...(sslcrldir !== undefined ? { sslcrldir } : {}),
    ...(sslkeylogfile !== undefined ? { sslkeylogfile } : {}),
    ...(sslsni !== undefined ? { sslsni } : {}),
    ...(keepalives !== undefined ? { keepalives } : {}),
    ...(keepalivesIdle !== undefined ? { keepalivesIdle } : {}),
    ...(requirepeer !== undefined ? { requirepeer } : {}),
    ...(sslMinProtocolVersion !== undefined ? { sslMinProtocolVersion } : {}),
    ...(sslMaxProtocolVersion !== undefined ? { sslMaxProtocolVersion } : {}),
  };
};

/**
 * Parse a libpq 0/1 boolean connection parameter (`sslsni`, `keepalives`).
 * libpq's `parse_bool_with_len` accepts `1`/`0`, `true`/`false`, `yes`/`no`,
 * `on`/`off` (case-insensitive). Returns `undefined` for unset / empty /
 * unrecognised so the caller falls back to libpq's default (enabled).
 */
const parseLibpqBool = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined || raw === '') return undefined;
  switch (raw.toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return undefined;
  }
};

/**
 * Parse `keepalives_idle` (seconds, non-negative integer). Returns the value
 * in seconds, or `undefined` if unset / malformed (the wire layer converts to
 * milliseconds for `socket.setKeepAlive`'s `initialDelay`).
 */
const parseKeepalivesIdle = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

const nonEmpty = (v: string | undefined): string | undefined =>
  v === undefined || v === '' ? undefined : v;

/**
 * Resolve the final {host, port}[] list for a URI:
 *
 *  1. Start from the authority. `?host=`/`?port=` query overrides take
 *     precedence (libpq semantics).
 *  2. If `host=h1,h2,…` is supplied, parse the comma-list. Ports come from
 *     `port=p1,p2,…`; must match the host count or be a single value
 *     (broadcast to all hosts).
 *  3. If only the authority had multi-host tuples (`postgresql://h1,h2/db`),
 *     use those.
 *  4. Otherwise fall back to single-host.
 *
 * Validates every port is in 1..65535 and surfaces a clear error otherwise.
 */
const computeHostsTuples = (input: {
  rawHost: string | undefined;
  rawPort: string | undefined;
  rawAuthorityHosts: { host: string; port?: string }[] | undefined;
  queryHost: string | undefined;
  queryPort: string | undefined;
}): { host: string; port: number }[] => {
  const { rawHost, rawPort, rawAuthorityHosts, queryHost, queryPort } = input;

  // Case A: ?host=… overrides the authority host(s). Port resolution still
  // prefers `?port=` (if supplied), but falls back to the authority port so
  // e.g. `postgres://:12345?host=/path/to/socket` keeps `port=12345`.
  if (queryHost !== undefined && queryHost !== '') {
    const hosts = queryHost.split(',').map((h) => h.trim());
    const portList =
      queryPort !== undefined && queryPort !== ''
        ? queryPort.split(',').map((p) => p.trim())
        : null;
    if (
      portList !== null &&
      portList.length !== 1 &&
      portList.length !== hosts.length
    ) {
      throw new Error(
        `could not match ${String(portList.length)} port numbers to ${String(hosts.length)} hosts`,
      );
    }
    return hosts.map((h, idx) => {
      let portStr: string | undefined;
      if (portList !== null) {
        portStr = portList.length === 1 ? portList[0] : portList[idx];
      } else {
        // Fall back to the authority port. Multi-host without an explicit
        // ?port= list shares the authority port across all hosts.
        portStr = rawPort;
      }
      return { host: h, port: parsePort(portStr) };
    });
  }

  // Case B: authority carried a comma-list (`postgresql://h1,h2:5433/db`).
  // Query-string `?port=` can still broadcast or pair with this list.
  if (rawAuthorityHosts !== undefined && rawAuthorityHosts.length > 0) {
    const portList =
      queryPort !== undefined && queryPort !== ''
        ? queryPort.split(',').map((p) => p.trim())
        : null;
    if (
      portList !== null &&
      portList.length !== 1 &&
      portList.length !== rawAuthorityHosts.length
    ) {
      throw new Error(
        `could not match ${String(portList.length)} port numbers to ${String(rawAuthorityHosts.length)} hosts`,
      );
    }
    return rawAuthorityHosts.map((t, idx) => ({
      host: t.host,
      port: parsePort(
        portList !== null
          ? portList.length === 1
            ? portList[0]
            : portList[idx]
          : t.port,
      ),
    }));
  }

  // Case C: single-host. Honour `?port=` (single value) if provided.
  const portStr = queryPort ?? rawPort;
  const host = rawHost !== undefined && rawHost !== '' ? rawHost : '';
  return [{ host, port: parsePort(portStr) }];
};

const parsePort = (raw: string | undefined): number => {
  if (raw === undefined || raw === '') return 5432;
  // `Number.parseInt` silently tolerates trailing junk (`parseInt("12345 12")`
  // === 12345), which would let an internal-whitespace value like the upstream
  // `port = 12345 12` URI case sneak through as port 12345. libpq rejects that
  // shape with `invalid integer value "<v>" for connection option "port"`,
  // pointing at the whole bogus value (the whitespace included) rather than a
  // generic out-of-range message. Detect any digits-then-garbage value here so
  // that exact wording fires; genuinely non-numeric (`abc`) and out-of-range
  // (`99999`) values keep the shorter `invalid port:` diagnostic.
  if (/^\d/.test(raw) && !/^\d+$/.test(raw)) {
    throw new Error(
      `invalid integer value "${raw}" for connection option "port"`,
    );
  }
  const p = Number.parseInt(raw, 10);
  if (!Number.isFinite(p) || p <= 0 || p > 65535) {
    throw new Error(`invalid port: ${raw}`);
  }
  return p;
};

/**
 * Parse a libpq-style conninfo string into a `Partial<ConnectOptions>`.
 *
 * The grammar is roughly `key = value` pairs separated by whitespace, where
 * values may be quoted with single quotes (libpq's `\'` is honored as an
 * embedded single-quote, but we don't model the full backslash-escape
 * universe — there's no test corpus that exercises it). Unknown keys are
 * rejected so a typo like `replicate=database` produces a clear error
 * rather than silently dropping the parameter.
 *
 * Recognised keys mirror the URI-side `KNOWN_QUERY_KEYS` allowlist plus
 * the authority-style keys (`host`, `port`, `user`, `dbname`, `password`).
 * `replication` is normalised through `normalizeReplication` for libpq
 * value-set compatibility.
 *
 * Out of scope: percent-decoding (conninfo strings are NOT percent-encoded),
 * `service` resolution from `pg_service.conf`, `passfile` resolution.
 */
export const parseConninfo = (input: string): Partial<ConnectOptions> => {
  const out: Partial<ConnectOptions> & {
    _hostList?: string[];
    _portList?: string[];
  } = {};
  let i = 0;
  const n = input.length;
  while (i < n) {
    // Skip whitespace between pairs.
    while (i < n && /\s/.test(input[i])) i += 1;
    if (i >= n) break;
    // Parse key: chars up to `=` or whitespace.
    const keyStart = i;
    while (i < n && input[i] !== '=' && !/\s/.test(input[i])) i += 1;
    const key = input.slice(keyStart, i).toLowerCase();
    if (key === '') break;
    // Skip whitespace before `=`.
    while (i < n && /\s/.test(input[i])) i += 1;
    if (i >= n || input[i] !== '=') {
      throw new Error(`missing "=" after "${key}" in conninfo string`);
    }
    i += 1; // consume `=`
    // Skip whitespace after `=`.
    while (i < n && /\s/.test(input[i])) i += 1;
    // Parse value: either single-quoted (with `\'` and `\\` escapes) or
    // bare up to next whitespace.
    let value: string;
    if (i < n && input[i] === "'") {
      i += 1; // consume opening quote
      const parts: string[] = [];
      while (i < n && input[i] !== "'") {
        if (input[i] === '\\' && i + 1 < n) {
          parts.push(input[i + 1]);
          i += 2;
        } else {
          parts.push(input[i]);
          i += 1;
        }
      }
      if (i >= n) {
        throw new Error(
          `unterminated single quote in conninfo string for key "${key}"`,
        );
      }
      i += 1; // consume closing quote
      value = parts.join('');
    } else {
      const valStart = i;
      while (i < n && !/\s/.test(input[i])) i += 1;
      value = input.slice(valStart, i);
    }
    applyConninfoPair(out, key, value);
  }
  // Materialise multi-host list. The scalar `host`/`port` already hold the
  // first entry (so single-host callers see no surface change); we only
  // surface `hosts` when the comma-list had ≥2 entries.
  const hostList = out._hostList;
  const portList = out._portList;
  if (hostList !== undefined && hostList.length > 0) {
    if (
      portList !== undefined &&
      portList.length !== 1 &&
      portList.length !== hostList.length
    ) {
      throw new Error(
        `could not match ${String(portList.length)} port numbers to ${String(hostList.length)} hosts`,
      );
    }
    if (hostList.length > 1) {
      out.hosts = hostList.map((h, idx) => ({
        host: h,
        port:
          portList === undefined
            ? (out.port ?? 5432)
            : portList.length === 1
              ? parsePort(portList[0])
              : parsePort(portList[idx]),
      }));
    }
  }
  // Drop the private staging fields before returning to the caller.
  // `_service` is left in place — the layered connect resolver in
  // `core/startup.ts` doesn't see this struct; only `runPsql` extracts
  // and forwards the service name. The caller deletes the slot after
  // reading it.
  delete out._hostList;
  delete out._portList;
  assertTlsProtocolRange(out.sslMinProtocolVersion, out.sslMaxProtocolVersion);
  assertTlsMaxProtocolSupported(out.sslMaxProtocolVersion);
  return out;
};

const applyConninfoPair = (
  out: Partial<ConnectOptions> & {
    _hostList?: string[];
    _portList?: string[];
  },
  key: string,
  value: string,
): void => {
  switch (key) {
    case 'host': {
      // Multi-host: `host=h1,h2,h3`. Store the list aside; the post-pass
      // (finalizeConninfo) materialises it into `hosts` + matches up against
      // any `port=p1,p2,p3` list.
      if (value.includes(',')) {
        out._hostList = value.split(',').map((h) => h.trim());
        out.host = out._hostList[0];
      } else {
        out.host = value;
        out._hostList = undefined;
      }
      return;
    }
    case 'port': {
      if (value.includes(',')) {
        out._portList = value.split(',').map((p) => p.trim());
        // First port still goes into the scalar slot for back-compat.
        out.port = parsePort(out._portList[0]);
      } else {
        out.port = parsePort(value);
        out._portList = undefined;
      }
      return;
    }
    case 'user':
      out.user = value;
      return;
    case 'password':
      out.password = value;
      return;
    case 'dbname':
      out.database = value;
      return;
    case 'application_name':
      out.applicationName = value;
      return;
    case 'sslmode':
      out.ssl = normalizeSslMode(value);
      return;
    case 'channel_binding': {
      const cb = normalizeChannelBinding(value);
      if (cb !== undefined) out.channelBinding = cb;
      return;
    }
    case 'require_auth': {
      const ra = normalizeRequireAuth(value);
      if (ra !== undefined) out.requireAuth = ra;
      return;
    }
    case 'connect_timeout': {
      const t = Number.parseInt(value, 10);
      if (Number.isFinite(t) && t >= 0) {
        out.connectTimeoutMs = t * 1000;
      }
      return;
    }
    case 'client_encoding':
      out.clientEncoding = value;
      return;
    case 'options':
      out.options = value;
      return;
    case 'replication': {
      const rep = normalizeReplication(value);
      if (rep !== undefined) out.replication = rep;
      return;
    }
    case 'target_session_attrs': {
      const tsa = normalizeTargetSessionAttrs(value);
      if (tsa !== undefined) out.targetSessionAttrs = tsa;
      return;
    }
    case 'load_balance_hosts': {
      const lbh = normalizeLoadBalanceHosts(value);
      if (lbh !== undefined) out.loadBalanceHosts = lbh;
      return;
    }
    case 'gssencmode':
      // Unsupported (no GSSAPI); accept disable/prefer, reject require.
      validateGssEncMode(value);
      return;
    case 'sslcert':
      if (value !== '') out.sslcert = value;
      return;
    case 'sslkey':
      if (value !== '') out.sslkey = value;
      return;
    case 'sslcertmode': {
      const cm = normalizeSslCertMode(value);
      if (cm !== undefined) out.sslcertmode = cm;
      return;
    }
    case 'sslnegotiation': {
      const sn = normalizeSslNegotiation(value);
      if (sn !== undefined) out.sslnegotiation = sn;
      return;
    }
    case 'sslrootcert':
      if (value !== '') out.sslrootcert = value;
      return;
    case 'sslcrl':
      if (value !== '') out.sslcrl = value;
      return;
    case 'sslcrldir':
      if (value !== '') out.sslcrldir = value;
      return;
    case 'sslkeylogfile':
      if (value !== '') out.sslkeylogfile = value;
      return;
    case 'hostaddr':
      if (value !== '') out.hostaddr = value;
      return;
    case 'ssl_min_protocol_version': {
      const v = normalizeTlsProtocolVersion(
        value === '' ? undefined : value,
        'ssl_min_protocol_version',
      );
      if (v !== undefined) out.sslMinProtocolVersion = v;
      return;
    }
    case 'ssl_max_protocol_version': {
      const v = normalizeTlsProtocolVersion(
        value === '' ? undefined : value,
        'ssl_max_protocol_version',
      );
      if (v !== undefined) out.sslMaxProtocolVersion = v;
      return;
    }
    case 'sslsni': {
      const b = parseLibpqBool(value);
      if (b !== undefined) out.sslsni = b;
      return;
    }
    case 'keepalives': {
      const b = parseLibpqBool(value);
      if (b !== undefined) out.keepalives = b;
      return;
    }
    case 'keepalives_idle': {
      const n = parseKeepalivesIdle(value);
      if (n !== undefined) out.keepalivesIdle = n;
      return;
    }
    case 'requirepeer':
      if (value !== '') out.requirepeer = value;
      return;
    // Recognised libpq keys that we don't model — accept silently so we
    // don't reject legitimate connection strings. keepalives_interval /
    // keepalives_count have no Node net API equivalent (setKeepAlive only
    // exposes enable + initial delay) — recognised but cannot be applied.
    case 'passfile':
    case 'sslcompression':
    case 'krbsrvname':
    case 'gsslib':
    case 'fallback_application_name':
    case 'keepalives_interval':
    case 'keepalives_count':
      return;
    case 'service': {
      // Service name is NOT a ConnectOptions field — it's resolved by
      // the layered connect resolver in `core/startup.ts`. Stash it on
      // a private staging slot so the caller (`runPsql`) can extract it
      // alongside the URI-side `?service=…` parser.
      (out as Partial<ConnectOptions> & { _service?: string })._service = value;
      return;
    }
    default:
      throw new Error(`invalid conninfo key: "${key}"`);
  }
};

/**
 * Heuristic: does the `-d` value look like a connection URI or a conninfo
 * string (vs. a bare database name)? Mirrors libpq's
 * `recognized_connection_string()` test.
 */
export const looksLikeConnectionString = (s: string): boolean => {
  if (s.startsWith('postgresql://') || s.startsWith('postgres://')) return true;
  // A bare key=value pair (or several) — conninfo. We require the `=` to
  // appear before any whitespace so values like "weird name" (a bareword
  // database name with a space) don't get misclassified.
  const eq = s.indexOf('=');
  if (eq < 0) return false;
  const head = s.slice(0, eq);
  return !/\s/.test(head);
};

const normalizeSslMode = (raw: string | null): ConnectOptions['ssl'] => {
  const value = (raw ?? 'prefer').toLowerCase();
  switch (value) {
    case 'disable':
    case 'allow':
    case 'prefer':
    case 'require':
    case 'verify-ca':
    case 'verify-full':
      return value;
    default:
      return 'prefer';
  }
};

/**
 * libpq's accepted TLS protocol-version names, in ascending order. The
 * index doubles as the comparison key for the `min > max` check. Matching
 * is case-insensitive on input (libpq lowercases before comparing) but we
 * keep the canonical mixed-case spelling Node's `tls` module expects for
 * `minVersion` / `maxVersion`.
 */
const TLS_PROTOCOL_VERSIONS = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];

/**
 * Validate and canonicalise a `ssl_{min,max}_protocol_version` value. Returns
 * the canonical spelling (`TLSv1.2` etc.) or `undefined` for empty / unset.
 * Throws libpq's `invalid <key> value: "<raw>"` wording on a malformed value.
 */
const normalizeTlsProtocolVersion = (
  raw: string | undefined,
  key: 'ssl_min_protocol_version' | 'ssl_max_protocol_version',
): string | undefined => {
  if (raw === undefined || raw === '') return undefined;
  const match = TLS_PROTOCOL_VERSIONS.find(
    (v) => v.toLowerCase() === raw.toLowerCase(),
  );
  if (match === undefined) {
    throw new Error(`invalid ${key} value: "${raw}"`);
  }
  return match;
};

/**
 * Reject a `ssl_max_protocol_version` ceiling below TLSv1.2. TLS 1.0/1.1 are
 * disabled in Node's bundled OpenSSL, so capping the ceiling there leaves no
 * negotiable protocol and the handshake otherwise fails with an opaque
 * `ERR_SSL_NO_PROTOCOLS_AVAILABLE` — surface an actionable message at parse
 * time instead. Only the MAX is gated: a low *min*
 * (`ssl_min_protocol_version=TLSv1.1`) is harmless because Node still
 * negotiates the highest mutually-supported version (1.2/1.3), exactly as
 * libpq does on a modern OpenSSL. Called AFTER {@link assertTlsProtocolRange}
 * so an inverted range (min > max) reports the range error first, matching
 * libpq's ordering.
 */
const assertTlsMaxProtocolSupported = (max: string | undefined): void => {
  if (max === 'TLSv1' || max === 'TLSv1.1') {
    throw new Error(
      `ssl_max_protocol_version "${max}" is not supported by this ` +
        `runtime's TLS library — TLS 1.0/1.1 are disabled in Node's OpenSSL; ` +
        `the minimum negotiable version is TLSv1.2`,
    );
  }
};

/**
 * Reject a `ssl_min_protocol_version` that is higher than
 * `ssl_max_protocol_version`, matching libpq's
 * `ssl_min_protocol_version must be <= ssl_max_protocol_version` diagnostic.
 * Both arguments must already be canonicalised by
 * {@link normalizeTlsProtocolVersion}.
 */
const assertTlsProtocolRange = (
  min: string | undefined,
  max: string | undefined,
): void => {
  if (min === undefined || max === undefined) return;
  if (TLS_PROTOCOL_VERSIONS.indexOf(min) > TLS_PROTOCOL_VERSIONS.indexOf(max)) {
    throw new Error(
      `ssl_min_protocol_version must be <= ssl_max_protocol_version`,
    );
  }
};

const normalizeChannelBinding = (
  raw: string | null,
): ConnectOptions['channelBinding'] => {
  if (raw === null || raw === '') return undefined;
  const value = raw.toLowerCase();
  switch (value) {
    case 'disable':
    case 'prefer':
    case 'require':
      return value;
    default:
      // Mirror libpq's `invalid channel_binding value: "<raw>"`
      // diagnostic (upstream test `002_scram.pl`). Empty / unset
      // returns `undefined` above so the wire-layer default applies.
      throw new Error(`invalid channel_binding value: "${raw}"`);
  }
};

/**
 * Validate libpq's `gssencmode` (GSSAPI transport encryption).
 *
 * This client has NO GSSAPI support: GSS-API `gss_wrap`/`gss_unwrap` would
 * require a native Kerberos addon (e.g. the `kerberos` npm), which the
 * embedded psql deliberately avoids (pure-TS, zero native bindings — the
 * same reason the line editor is hand-rolled). `node-postgres` doesn't
 * support it either. So:
 *   - `disable` / `prefer` — accepted and ignored: neither needs GSS
 *     (`prefer` means "try GSS, else fall back", and falling back to the
 *     non-GSS path is exactly what we always do).
 *   - `require` — rejected with a clear diagnostic; we cannot satisfy it.
 *   - anything else — `invalid gssencmode value`.
 * We recognise the parameter (rather than rejecting it as an unknown key)
 * so the many tools that always append `gssencmode=...` to a URI keep
 * working against Neon.
 */
const validateGssEncMode = (raw: string | null): void => {
  if (raw === null || raw === '') return;
  const value = raw.toLowerCase();
  if (value === 'disable' || value === 'prefer') return;
  if (value === 'require') {
    throw new Error(
      'gssencmode=require is not supported: this client has no GSSAPI support',
    );
  }
  throw new Error(`invalid gssencmode value: "${raw}"`);
};

/**
 * Parse libpq's `sslcertmode` value (`disable` / `allow` / `require`).
 * Empty / unset returns `undefined` so the wire-layer default (`allow`)
 * applies. A malformed value throws libpq's
 * `invalid sslcertmode value: "<raw>"` diagnostic.
 */
const normalizeSslCertMode = (
  raw: string | null,
): ConnectOptions['sslcertmode'] => {
  if (raw === null || raw === '') return undefined;
  const value = raw.toLowerCase();
  switch (value) {
    case 'disable':
    case 'allow':
    case 'require':
      return value;
    default:
      throw new Error(`invalid sslcertmode value: "${raw}"`);
  }
};

/**
 * Parse libpq's `sslnegotiation` value (`postgres` / `direct`). Empty / unset
 * returns `undefined` so the wire-layer default (`postgres`, the classic
 * SSLRequest flow) applies. A malformed value throws libpq's
 * `invalid sslnegotiation value: "<raw>"` diagnostic.
 */
const normalizeSslNegotiation = (
  raw: string | null,
): ConnectOptions['sslnegotiation'] => {
  if (raw === null || raw === '') return undefined;
  const value = raw.toLowerCase();
  switch (value) {
    case 'postgres':
    case 'direct':
      return value;
    default:
      throw new Error(`invalid sslnegotiation value: "${raw}"`);
  }
};

/**
 * libpq constraint: `sslnegotiation=direct` may only be used with an encrypted
 * sslmode (`require` / `verify-ca` / `verify-full`). Direct SSL starts the TLS
 * handshake immediately with no plaintext fallback, so a "weak" mode that could
 * end up unencrypted (`disable` / `allow` / `prefer`) is rejected with libpq's
 * exact `pqConnectOptions2` wording. No-op unless `sslnegotiation` is `direct`.
 */
const assertSslNegotiationModeCompatible = (
  ssl: ConnectOptions['ssl'],
  sslnegotiation: ConnectOptions['sslnegotiation'],
): void => {
  if (sslnegotiation !== 'direct') return;
  if (ssl === 'require' || ssl === 'verify-ca' || ssl === 'verify-full') {
    return;
  }
  throw new Error(
    `weak sslmode "${ssl}" may not be used with sslnegotiation=direct`,
  );
};

const VALID_REQUIRE_AUTH_METHODS = new Set<RequireAuthMethod>([
  'password',
  'md5',
  'gss',
  'sspi',
  'scram-sha-256',
  'creds',
  'none',
]);

/**
 * Parse libpq's `require_auth` value: a comma-separated list of method
 * names where each entry may be prefixed with `!` to negate. Mixing
 * positive and negative entries is forbidden (libpq matches this).
 *
 * Returns `undefined` for empty input so the wire-layer default applies.
 * Throws on invalid syntax with libpq-parity wording, surfaced via the
 * outer `psql: error: ...` channel.
 */
const normalizeRequireAuth = (
  raw: string | null,
): ConnectOptions['requireAuth'] => {
  if (raw === null || raw === '') return undefined;
  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) return undefined;
  const methods = new Set<RequireAuthMethod>();
  let polarity: boolean | null = null;
  for (const token of tokens) {
    const isNeg = token.startsWith('!');
    const name = (isNeg ? token.slice(1) : token).toLowerCase();
    if (!VALID_REQUIRE_AUTH_METHODS.has(name as RequireAuthMethod)) {
      throw new Error(`invalid require_auth method: "${token}"`);
    }
    if (polarity === null) {
      polarity = isNeg;
    } else if (polarity !== isNeg) {
      // libpq wording: "negative require_auth method ... cannot be mixed
      // with non-negative methods". We use a slightly shorter form here.
      throw new Error(
        'require_auth methods cannot mix positive and negative entries',
      );
    }
    methods.add(name as RequireAuthMethod);
  }
  return { methods, negated: polarity ?? false };
};

/**
 * Accept the libpq-spec set for `target_session_attrs`. Aliases `read-write`/
 * `primary` and `read-only`/`standby` are kept distinct because the wire
 * layer treats the canonical four values identically — we only normalise
 * unknown / empty inputs to `undefined` so the wire-layer default ('any')
 * applies. Throws on unrecognised values, matching libpq behaviour.
 */
const normalizeTargetSessionAttrs = (
  raw: string | null,
): ConnectOptions['targetSessionAttrs'] | undefined => {
  if (raw === null || raw === '') return undefined;
  const value = raw.toLowerCase();
  switch (value) {
    case 'any':
    case 'read-write':
    case 'read-only':
    case 'primary':
    case 'standby':
    case 'prefer-standby':
      return value;
    default:
      throw new Error(`invalid value for "target_session_attrs": "${raw}"`);
  }
};

/**
 * Accept the libpq-spec set for `load_balance_hosts`:
 *   - `disable` (default) — preserve list order
 *   - `random`            — shuffle before iteration
 *
 * Unknown values throw; empty / unset returns `undefined` so the wire layer
 * default ('disable') applies.
 */
const normalizeLoadBalanceHosts = (
  raw: string | null,
): ConnectOptions['loadBalanceHosts'] | undefined => {
  if (raw === null || raw === '') return undefined;
  const value = raw.toLowerCase();
  if (value === 'disable' || value === 'random') return value;
  throw new Error(`invalid value for "load_balance_hosts": "${raw}"`);
};

/**
 * libpq accepts a wide set of "truthy" values for `replication`:
 *   - `true` / `on` / `yes` / `1`     → physical replication (mapped to `true`)
 *   - `false` / `off` / `no` / `0`    → not a walsender (no replication mode)
 *   - `database`                       → logical replication on that DB
 *
 * Returns `undefined` when no value was supplied or when it explicitly
 * disables replication; throws for unrecognised input (matching libpq's
 * `"invalid <…> value"` semantics so users see a clear error rather than
 * silently sending an unexpected startup-message parameter).
 */
const normalizeReplication = (
  raw: string | null,
): ConnectOptions['replication'] | undefined => {
  if (raw === null || raw === '') return undefined;
  const value = raw.toLowerCase();
  if (value === 'database') return 'database';
  if (value === 'true' || value === 'on' || value === 'yes' || value === '1') {
    return 'true';
  }
  if (value === 'false' || value === 'off' || value === 'no' || value === '0') {
    return undefined;
  }
  throw new Error(`invalid value for "replication": "${raw}"`);
};

// ---------------------------------------------------------------------------
// Layered connection-parameter resolution.
//
// Vanilla psql consults several sources in priority order when filling in
// connection parameters. Order (highest → lowest):
//
//   1. Explicit URI / conninfo (what the user passed on the command line)
//   2. Argv flags (`-h`, `-p`, etc.)
//   3. PG* env vars
//   4. ~/.pgpass (password only; matched against host/port/db/user)
//   5. pg_service.conf (when PGSERVICE / ?service= is set)
//   6. libpq compiled-in defaults (localhost / 5432 / USER / database=user)
//
// The historical `parseConnectionUri` bakes (1) and (6) into a single
// `ConnectOptions`, which makes layering impossible. `parseConnectionUriPartial`
// gives the same parser surface but returns ONLY the fields the URI
// explicitly set — leaving env / pgpass / service / defaults to fill the
// gaps via `mergeConnectOptions`.
// ---------------------------------------------------------------------------

/**
 * Service name extracted from a connection URI's `?service=` query
 * parameter, if any. Surfaced alongside `parseConnectionUriPartial` so the
 * caller can route the lookup into `applyStartupArgs` without re-parsing
 * the URI.
 */
export const parseConnectionUriService = (uri: string): string | undefined => {
  const raw = tokenizeConnectionUri(uri);
  const value = raw.query.get('service');
  return value === undefined || value === '' ? undefined : value;
};

/**
 * Parse a URI into a `Partial<ConnectOptions>` containing only the fields
 * the URI explicitly supplied. Returned shape:
 *
 *   - missing fields are absent (no `undefined` placeholders)
 *   - `host`/`port` are populated only when the URI authority or `?host=`
 *     specified them
 *   - `user`/`password`/`database`/`ssl`/`channelBinding`/... follow the
 *     same rule — present iff explicitly set
 *
 * This is the building block for the layered merge in `applyStartupArgs`.
 * The full-defaults variant `parseConnectionUri` remains the right choice
 * for callers that want a complete `ConnectOptions` (e.g. the existing
 * `-d URI` path); it's kept untouched for back-compat.
 */
export const parseConnectionUriPartial = (
  uri: string,
): Partial<ConnectOptions> => {
  const raw = tokenizeConnectionUri(uri);

  const queryUser = raw.query.get('user');
  const queryPassword = raw.query.get('password');
  const queryPort = raw.query.get('port');
  const queryDbname = raw.query.get('dbname');
  const queryHost = raw.query.get('host');

  // Multi-host: same resolution as the full parser, but we treat its absence
  // as "URI didn't say anything about hosts" rather than synthesising a
  // localhost default.
  const hostsTuples = computeHostsTuples({
    rawHost: raw.host,
    rawPort: raw.port,
    rawAuthorityHosts: raw.hosts,
    queryHost,
    queryPort,
  });

  // Did the URI actually mention a port anywhere? `parsePort()` defaults
  // empty input to 5432, so `hostsTuples[i].port` is ALWAYS a number even
  // for a URI like `postgres:///?service=foo` (no port specified). We
  // need to distinguish "URI explicitly said 5432" from "URI said nothing
  // about a port" so the service-file's port wins when we layer this
  // partial above the service layer. Mirrors libpq's behaviour for
  // `006_service.pl`'s `postgres:///?service=…` cases.
  const portInUri =
    (raw.port !== undefined && raw.port !== '') ||
    (queryPort !== undefined && queryPort !== '') ||
    (raw.hosts?.some((t) => t.port !== undefined && t.port !== '') ?? false);

  const out: Partial<ConnectOptions> = {};

  if (hostsTuples.length > 0) {
    // First tuple drives the single-host surface; the full multi-host list
    // is included only when the URI specified more than one. An empty-host
    // tuple (e.g. `postgres://:12345/`) means "explicit port, no host" —
    // we record the port but leave host to the next layer.
    if (hostsTuples[0].host !== '') out.host = hostsTuples[0].host;
    if (portInUri && hostsTuples[0].port !== 0) out.port = hostsTuples[0].port;
    if (hostsTuples.length > 1) {
      out.hosts = hostsTuples.map((t) => ({ host: t.host, port: t.port }));
    }
  }

  const userExplicit =
    queryUser !== undefined && queryUser !== ''
      ? queryUser
      : raw.user !== undefined && raw.user !== ''
        ? raw.user
        : undefined;
  if (userExplicit !== undefined) out.user = userExplicit;

  const password = queryPassword ?? raw.password;
  if (password !== undefined) out.password = password;

  const database = queryDbname ?? raw.database;
  if (database !== undefined) out.database = database;

  const sslRaw = raw.query.get('sslmode');
  if (sslRaw !== undefined && sslRaw !== '') {
    out.ssl = normalizeSslMode(sslRaw);
  }

  const cb = normalizeChannelBinding(raw.query.get('channel_binding') ?? null);
  if (cb !== undefined) out.channelBinding = cb;

  const ra = normalizeRequireAuth(raw.query.get('require_auth') ?? null);
  if (ra !== undefined) out.requireAuth = ra;

  const options = raw.query.get('options');
  if (options !== undefined && options !== '') out.options = options;

  const appName = raw.query.get('application_name');
  if (appName !== undefined && appName !== '') out.applicationName = appName;

  const replication = normalizeReplication(
    raw.query.get('replication') ?? null,
  );
  if (replication !== undefined) out.replication = replication;

  const targetSessionAttrs = normalizeTargetSessionAttrs(
    raw.query.get('target_session_attrs') ?? null,
  );
  if (targetSessionAttrs !== undefined) {
    out.targetSessionAttrs = targetSessionAttrs;
  }

  const loadBalanceHosts = normalizeLoadBalanceHosts(
    raw.query.get('load_balance_hosts') ?? null,
  );
  if (loadBalanceHosts !== undefined) out.loadBalanceHosts = loadBalanceHosts;

  const sslcert = nonEmpty(raw.query.get('sslcert'));
  if (sslcert !== undefined) out.sslcert = sslcert;
  const sslkey = nonEmpty(raw.query.get('sslkey'));
  if (sslkey !== undefined) out.sslkey = sslkey;
  const sslcertmode = normalizeSslCertMode(
    raw.query.get('sslcertmode') ?? null,
  );
  if (sslcertmode !== undefined) out.sslcertmode = sslcertmode;
  const sslnegotiation = normalizeSslNegotiation(
    raw.query.get('sslnegotiation') ?? null,
  );
  if (sslnegotiation !== undefined) out.sslnegotiation = sslnegotiation;
  const sslrootcert = nonEmpty(raw.query.get('sslrootcert'));
  if (sslrootcert !== undefined) out.sslrootcert = sslrootcert;
  const sslcrl = nonEmpty(raw.query.get('sslcrl'));
  if (sslcrl !== undefined) out.sslcrl = sslcrl;
  const sslcrldir = nonEmpty(raw.query.get('sslcrldir'));
  if (sslcrldir !== undefined) out.sslcrldir = sslcrldir;
  const sslkeylogfile = nonEmpty(raw.query.get('sslkeylogfile'));
  if (sslkeylogfile !== undefined) out.sslkeylogfile = sslkeylogfile;
  const sslsni = parseLibpqBool(nonEmpty(raw.query.get('sslsni')));
  if (sslsni !== undefined) out.sslsni = sslsni;
  const keepalives = parseLibpqBool(nonEmpty(raw.query.get('keepalives')));
  if (keepalives !== undefined) out.keepalives = keepalives;
  const keepalivesIdle = parseKeepalivesIdle(
    nonEmpty(raw.query.get('keepalives_idle')),
  );
  if (keepalivesIdle !== undefined) out.keepalivesIdle = keepalivesIdle;
  const requirepeer = nonEmpty(raw.query.get('requirepeer'));
  if (requirepeer !== undefined) out.requirepeer = requirepeer;
  const hostaddr = nonEmpty(raw.query.get('hostaddr'));
  if (hostaddr !== undefined) out.hostaddr = hostaddr;
  const sslMin = normalizeTlsProtocolVersion(
    nonEmpty(raw.query.get('ssl_min_protocol_version')),
    'ssl_min_protocol_version',
  );
  if (sslMin !== undefined) out.sslMinProtocolVersion = sslMin;
  const sslMax = normalizeTlsProtocolVersion(
    nonEmpty(raw.query.get('ssl_max_protocol_version')),
    'ssl_max_protocol_version',
  );
  if (sslMax !== undefined) out.sslMaxProtocolVersion = sslMax;
  assertTlsProtocolRange(out.sslMinProtocolVersion, out.sslMaxProtocolVersion);
  assertTlsMaxProtocolSupported(out.sslMaxProtocolVersion);

  const connectTimeoutSec = raw.query.get('connect_timeout');
  if (connectTimeoutSec !== undefined && connectTimeoutSec !== '') {
    const t = Number.parseInt(connectTimeoutSec, 10);
    if (Number.isFinite(t) && t >= 0) out.connectTimeoutMs = t * 1000;
  }

  const clientEncoding = raw.query.get('client_encoding');
  if (clientEncoding !== undefined && clientEncoding !== '') {
    out.clientEncoding = clientEncoding;
  }

  return out;
};

// Field map for PG* env vars. Order in the table is documentation; resolution
// only depends on whether the var is set.
const PG_ENV_FIELD_MAP: Readonly<Record<string, keyof ConnectOptions>> = {
  PGHOST: 'host',
  PGHOSTADDR: 'hostaddr',
  PGPORT: 'port',
  PGUSER: 'user',
  PGDATABASE: 'database',
  PGPASSWORD: 'password',
  PGAPPNAME: 'applicationName',
  PGOPTIONS: 'options',
  PGCLIENTENCODING: 'clientEncoding',
  PGSSLMODE: 'ssl',
  PGSSLROOTCERT: 'sslrootcert',
  PGSSLCERT: 'sslcert',
  PGSSLKEY: 'sslkey',
  PGSSLCERTMODE: 'sslcertmode',
  PGSSLNEGOTIATION: 'sslnegotiation',
  PGSSLCRL: 'sslcrl',
  PGSSLCRLDIR: 'sslcrldir',
  PGSSLKEYLOGFILE: 'sslkeylogfile',
  PGCHANNELBINDING: 'channelBinding',
};

/**
 * Resolve the PG* env vars into a `Partial<ConnectOptions>`. Only set keys
 * end up in the result; unset / empty env vars are skipped so the caller
 * can layer this between URI overrides and pgpass / service / libpq
 * defaults without clobbering anything.
 *
 * Validation: any malformed value (e.g. `PGPORT=abc`) is silently dropped.
 * libpq behaves the same — the connection then fails later with a clearer
 * "could not parse" message, but the env-var lookup itself does not throw.
 *
 * Notes:
 *   - `PGHOSTADDR` maps to {@link ConnectOptions.hostaddr}: the wire layer
 *     dials this fixed IP while `PGHOST` still drives TLS SNI / cert
 *     verification.
 *   - `PGCONNECT_TIMEOUT` is in seconds; we convert to milliseconds.
 *   - `PGCHANNELBINDING` accepts disable/prefer/require.
 *   - `PGSERVICE` is consumed by the caller (it drives the
 *     pg_service.conf lookup) and is NOT a direct ConnectOptions field.
 *   - `PGSERVICEFILE`, `PGSYSCONFDIR`, `PGPASSFILE` are likewise consumed
 *     by the loaders, not surfaced here.
 */
export const envConnectionDefaults = (
  env: NodeJS.ProcessEnv,
): Partial<ConnectOptions> => {
  const out: Partial<ConnectOptions> = {};
  const get = (k: string): string | undefined => {
    const v = env[k];
    return v !== undefined && v !== '' ? v : undefined;
  };

  for (const [envName, field] of Object.entries(PG_ENV_FIELD_MAP)) {
    const value = get(envName);
    if (value === undefined) continue;
    applyEnvValue(out, field, value);
  }

  const timeoutRaw = get('PGCONNECT_TIMEOUT');
  if (timeoutRaw !== undefined) {
    const t = Number.parseInt(timeoutRaw, 10);
    if (Number.isFinite(t) && t >= 0) out.connectTimeoutMs = t * 1000;
  }

  // GSSAPI is unsupported; PGGSSENCMODE=require is rejected, disable/prefer
  // accepted-and-ignored. Same contract as the URI/conninfo `gssencmode`.
  validateGssEncMode(get('PGGSSENCMODE') ?? null);

  return out;
};

const applyEnvValue = (
  out: Partial<ConnectOptions>,
  field: keyof ConnectOptions,
  value: string,
): void => {
  switch (field) {
    case 'host':
      out.host = value;
      return;
    case 'port': {
      const p = Number.parseInt(value, 10);
      if (Number.isFinite(p) && p > 0 && p <= 65535) out.port = p;
      return;
    }
    case 'user':
      out.user = value;
      return;
    case 'database':
      out.database = value;
      return;
    case 'password':
      out.password = value;
      return;
    case 'applicationName':
      out.applicationName = value;
      return;
    case 'options':
      out.options = value;
      return;
    case 'clientEncoding':
      out.clientEncoding = value;
      return;
    case 'ssl':
      out.ssl = normalizeSslMode(value);
      return;
    case 'sslrootcert':
      out.sslrootcert = value;
      return;
    case 'sslcert':
      out.sslcert = value;
      return;
    case 'sslkey':
      out.sslkey = value;
      return;
    case 'sslcertmode': {
      const cm = normalizeSslCertMode(value);
      if (cm !== undefined) out.sslcertmode = cm;
      return;
    }
    case 'sslnegotiation': {
      const sn = normalizeSslNegotiation(value);
      if (sn !== undefined) out.sslnegotiation = sn;
      return;
    }
    case 'sslcrl':
      out.sslcrl = value;
      return;
    case 'sslcrldir':
      out.sslcrldir = value;
      return;
    case 'sslkeylogfile':
      out.sslkeylogfile = value;
      return;
    case 'hostaddr':
      out.hostaddr = value;
      return;
    case 'channelBinding': {
      const cb = normalizeChannelBinding(value);
      if (cb !== undefined) out.channelBinding = cb;
      return;
    }
    default:
      // Unhandled field — silently drop. Tightening this would require
      // narrowing the field-map type; not worth the complexity.
      return;
  }
};

/**
 * libpq compiled-in defaults. The lowest-priority layer in the merge chain.
 *
 *   - host: 'localhost'
 *   - port: 5432
 *   - user: $USER ?? '' (the wire layer surfaces a clear error if the user
 *     is still empty at connect time)
 *   - database: deferred — libpq defaults dbname to the user; we wire that
 *     in `mergeConnectOptions` after layering so a `PGUSER` env can flow
 *     into `database` when the user didn't specify one.
 *   - ssl: 'prefer'
 *   - applicationName: 'psql' — matches upstream so `pg_stat_activity` shows
 *     the value users expect.
 *   - sslcert / sslkey: libpq auto-loads the default client cert/key at
 *     `~/.postgresql/postgresql.crt` / `.key` when neither is configured AND
 *     the file exists. We seed these as the lowest-priority defaults via
 *     {@link defaultClientCertDefaults}; any explicit URI / env / conninfo
 *     value overrides them. A non-existent default file is simply not set
 *     (no error), matching libpq — only an explicit path that's missing
 *     surfaces an error (at TLS-load time, in the wire layer).
 */
export const libpqConnectionDefaults = (
  env: NodeJS.ProcessEnv,
): ConnectOptions => ({
  host: 'localhost',
  port: 5432,
  user: env.USER ?? '',
  database: '',
  ssl: 'prefer',
  applicationName: 'psql',
  ...defaultClientCertDefaults(env),
});

/**
 * libpq default client-certificate discovery. When the user has NOT set
 * `sslcert` / `sslkey` (explicit paths and `PGSSLCERT` / `PGSSLKEY` are
 * higher-priority layers), libpq falls back to `~/.postgresql/postgresql.crt`
 * and `~/.postgresql/postgresql.key` — but only if those files actually
 * exist. We mirror that here so a present default cert satisfies e.g.
 * `sslcertmode=require`.
 *
 * The home directory is taken from `env.HOME` (falling back to
 * `os.homedir()`), the same convention as the pgpass / pgservice loaders;
 * passing a synthetic `HOME` keeps this hermetic in tests.
 *
 * Exported for unit testing.
 */
export const defaultClientCertDefaults = (
  env: NodeJS.ProcessEnv,
): Partial<Pick<ConnectOptions, 'sslcert' | 'sslkey'>> => {
  const home = env.HOME ?? os.homedir();
  if (home === undefined || home === '') return {};
  const out: Partial<Pick<ConnectOptions, 'sslcert' | 'sslkey'>> = {};
  const certPath = path.join(home, '.postgresql', 'postgresql.crt');
  if (existsSync(certPath)) out.sslcert = certPath;
  const keyPath = path.join(home, '.postgresql', 'postgresql.key');
  if (existsSync(keyPath)) out.sslkey = keyPath;
  return out;
};

/**
 * Translate a `pg_service.conf` entry into a `Partial<ConnectOptions>`.
 * Unknown keys are silently dropped — the service file format admits
 * arbitrary keys but only the libpq-spec subset maps to ConnectOptions.
 *
 * Numeric / enum validation mirrors `parseConninfo` so an out-of-range
 * port or bogus sslmode in the service file fails the same way (silently
 * dropped here, since libpq itself only warns on invalid service values).
 */
export const serviceEntryToConnectOptions = (
  entry: Readonly<Record<string, string>>,
): Partial<ConnectOptions> => {
  const out: Partial<ConnectOptions> = {};
  for (const [k, v] of Object.entries(entry)) {
    const key = k.toLowerCase();
    switch (key) {
      case 'host':
        if (v !== '') out.host = v;
        break;
      case 'port': {
        const p = Number.parseInt(v, 10);
        if (Number.isFinite(p) && p > 0 && p <= 65535) out.port = p;
        break;
      }
      case 'user':
        if (v !== '') out.user = v;
        break;
      case 'dbname':
        if (v !== '') out.database = v;
        break;
      case 'password':
        out.password = v;
        break;
      case 'application_name':
        if (v !== '') out.applicationName = v;
        break;
      case 'sslmode':
        if (v !== '') out.ssl = normalizeSslMode(v);
        break;
      case 'channel_binding': {
        const cb = normalizeChannelBinding(v);
        if (cb !== undefined) out.channelBinding = cb;
        break;
      }
      case 'require_auth': {
        const ra = normalizeRequireAuth(v);
        if (ra !== undefined) out.requireAuth = ra;
        break;
      }
      case 'options':
        if (v !== '') out.options = v;
        break;
      case 'client_encoding':
        if (v !== '') out.clientEncoding = v;
        break;
      case 'sslcert':
        if (v !== '') out.sslcert = v;
        break;
      case 'sslkey':
        if (v !== '') out.sslkey = v;
        break;
      case 'sslcertmode': {
        const cm = normalizeSslCertMode(v);
        if (cm !== undefined) out.sslcertmode = cm;
        break;
      }
      case 'sslnegotiation': {
        const sn = normalizeSslNegotiation(v);
        if (sn !== undefined) out.sslnegotiation = sn;
        break;
      }
      case 'sslrootcert':
        if (v !== '') out.sslrootcert = v;
        break;
      case 'sslcrl':
        if (v !== '') out.sslcrl = v;
        break;
      case 'sslcrldir':
        if (v !== '') out.sslcrldir = v;
        break;
      case 'sslkeylogfile':
        if (v !== '') out.sslkeylogfile = v;
        break;
      case 'sslsni': {
        const b = parseLibpqBool(v);
        if (b !== undefined) out.sslsni = b;
        break;
      }
      case 'keepalives': {
        const b = parseLibpqBool(v);
        if (b !== undefined) out.keepalives = b;
        break;
      }
      case 'keepalives_idle': {
        const n = parseKeepalivesIdle(v);
        if (n !== undefined) out.keepalivesIdle = n;
        break;
      }
      case 'requirepeer':
        if (v !== '') out.requirepeer = v;
        break;
      case 'hostaddr':
        if (v !== '') out.hostaddr = v;
        break;
      case 'ssl_min_protocol_version': {
        const pv = normalizeTlsProtocolVersion(
          v === '' ? undefined : v,
          'ssl_min_protocol_version',
        );
        if (pv !== undefined) out.sslMinProtocolVersion = pv;
        break;
      }
      case 'ssl_max_protocol_version': {
        const pv = normalizeTlsProtocolVersion(
          v === '' ? undefined : v,
          'ssl_max_protocol_version',
        );
        if (pv !== undefined) out.sslMaxProtocolVersion = pv;
        break;
      }
      case 'connect_timeout': {
        const t = Number.parseInt(v, 10);
        if (Number.isFinite(t) && t >= 0) out.connectTimeoutMs = t * 1000;
        break;
      }
      // Recognised but not mapped — service files may contain `passfile`,
      // `krbsrvname`, etc. We drop silently rather than complain.
      default:
        break;
    }
  }
  assertTlsProtocolRange(out.sslMinProtocolVersion, out.sslMaxProtocolVersion);
  assertTlsMaxProtocolSupported(out.sslMaxProtocolVersion);
  return out;
};

/**
 * Merge layered partial ConnectOptions into a complete ConnectOptions.
 *
 * Layers are listed in PRIORITY order (highest first). For each output
 * field, the first layer that supplies a value wins. The implementation
 * walks the layers in reverse so the spread-into semantics match.
 *
 * `database` has a libpq-specific fallback: if every layer omits it, the
 * default is the resolved `user` (so `psql -U alice` connects to a
 * database named `alice`). We apply this AFTER all layers have run.
 */
export const mergeConnectOptions = (
  layers: readonly Partial<ConnectOptions>[],
  defaults: ConnectOptions,
): ConnectOptions => {
  let out: ConnectOptions = { ...defaults };
  // Apply layers from LOWEST → HIGHEST so higher-priority layers overwrite.
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    out = { ...out, ...layer };
  }
  // libpq: database defaults to the resolved user when no layer set it.
  // The default `database: ''` from `libpqConnectionDefaults` is the
  // sentinel for "nothing supplied".
  if (out.database === '') {
    out.database = out.user;
  }
  // libpq: `sslrootcert=system` raises the effective sslmode to verify-full
  // (it makes no sense to trust the public CA store without verifying the
  // chain AND the hostname). verify-full is the strongest mode, so this can
  // only ever raise — never downgrade — an explicitly requested mode.
  if (out.sslrootcert === 'system' && out.ssl !== 'verify-full') {
    out.ssl = 'verify-full';
  }
  // libpq validates `sslnegotiation=direct` against the FINAL sslmode (after
  // any `sslrootcert=system` raise and cross-layer merge), rejecting a weak
  // mode that could end up plaintext. Authoritative check across all layers.
  assertSslNegotiationModeCompatible(out.ssl, out.sslnegotiation);
  return out;
};
