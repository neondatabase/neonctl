import type { ConnectOptions } from './types/connection.js';
import type { REPLContext, Stdio } from './types/repl.js';
import type { StartupAction } from './core/startup.js';

import { PgConnection } from './wire/connection.js';
import { applyEnvOverrides, defaultSettings } from './core/settings.js';
import { createVarStore } from './core/variables.js';
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
import { promises as fs } from 'node:fs';

/**
 * Embedded TypeScript psql entrypoint.
 *
 * Argv shape mirrors the legacy native-psql call site:
 *   argv[0] = connection URI (postgresql://user:pw@host:port/db?sslmode=...)
 *   argv[1..] = forwarded psql args (currently passed through; honored by
 *               startup args parsing once WP-26 lands).
 */
export const runPsql = async (
  argv: string[],
  stdio: Stdio = {},
): Promise<number> => {
  const stdin = stdio.stdin ?? process.stdin;
  const stdout = stdio.stdout ?? process.stdout;
  const stderr = stdio.stderr ?? process.stderr;

  const connectionUri = argv[0] ?? '';
  if (!connectionUri) {
    stderr.write('psql: error: no connection URI provided\n');
    return EXIT_FAILURE;
  }

  let baseConnectOpts: ConnectOptions;
  try {
    baseConnectOpts = parseConnectionUri(connectionUri);
  } catch (err) {
    stderr.write(`psql: error: ${(err as Error).message}\n`);
    return EXIT_BADCONN;
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

  const { connect: connectOpts, preActions } = applyStartupArgs(
    parsed,
    settings,
    baseConnectOpts,
  );

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
  'sslcompression',
  'sslcert',
  'sslkey',
  'sslrootcert',
  'sslcrl',
  'sslsni',
  'requirepeer',
  'ssl_min_protocol_version',
  'ssl_max_protocol_version',
  'krbsrvname',
  'gsslib',
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

  // hostport: either [ipv6]:port, [ipv6], host:port, or host.
  let host: string | undefined;
  let port: string | undefined;
  if (rest.startsWith('[')) {
    const closeIdx = rest.indexOf(']');
    if (closeIdx < 0) {
      throw new Error(`missing matching "]" in IPv6 host address: ${uri}`);
    }
    host = rest.slice(1, closeIdx);
    if (host === '') {
      throw new Error(`IPv6 host address may not be empty: ${uri}`);
    }
    const after = rest.slice(closeIdx + 1);
    if (after.startsWith(':')) {
      port = after.slice(1);
    } else if (after !== '') {
      throw new Error(
        `unexpected characters after IPv6 host address in URI: ${uri}`,
      );
    }
  } else if (rest !== '') {
    const colon = rest.indexOf(':');
    if (colon >= 0) {
      host = decodePercent(rest.slice(0, colon));
      port = rest.slice(colon + 1);
    } else {
      host = decodePercent(rest);
    }
  }

  const queryMap = parseQuery(query);

  return { user, password, host, port, database, query: queryMap };
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

  const host =
    queryHost !== undefined && queryHost !== ''
      ? queryHost
      : raw.host !== undefined && raw.host !== ''
        ? raw.host
        : 'localhost';

  const portStr = queryPort ?? raw.port;
  let port = 5432;
  if (portStr !== undefined && portStr !== '') {
    const parsed = Number.parseInt(portStr, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error(`invalid port: ${portStr}`);
    }
    port = parsed;
  }

  const user =
    queryUser !== undefined && queryUser !== ''
      ? queryUser
      : raw.user !== undefined && raw.user !== ''
        ? raw.user
        : (process.env.USER ?? '');
  const password = queryPassword ?? raw.password;
  const database = queryDbname ?? raw.database ?? user;

  const ssl = normalizeSslMode(raw.query.get('sslmode') ?? null);
  const channelBinding = normalizeChannelBinding(
    raw.query.get('channel_binding') ?? null,
  );

  const options = raw.query.get('options');
  const applicationName = raw.query.get('application_name') ?? 'neonctl-psql';
  const replication = normalizeReplication(
    raw.query.get('replication') ?? null,
  );

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
    ...(replication !== undefined ? { replication } : {}),
  };
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
  const out: Partial<ConnectOptions> = {};
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
  return out;
};

const applyConninfoPair = (
  out: Partial<ConnectOptions>,
  key: string,
  value: string,
): void => {
  switch (key) {
    case 'host':
      out.host = value;
      return;
    case 'port': {
      const p = Number.parseInt(value, 10);
      if (!Number.isFinite(p) || p <= 0 || p > 65535) {
        throw new Error(`invalid port in conninfo: "${value}"`);
      }
      out.port = p;
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
    // Recognised libpq keys that we don't model — accept silently so we
    // don't reject legitimate connection strings (matches the URI
    // allowlist's "known but not honored" entries like hostaddr / sslcert
    // / target_session_attrs).
    case 'hostaddr':
    case 'passfile':
    case 'sslcompression':
    case 'sslcert':
    case 'sslkey':
    case 'sslrootcert':
    case 'sslcrl':
    case 'sslsni':
    case 'requirepeer':
    case 'ssl_min_protocol_version':
    case 'ssl_max_protocol_version':
    case 'krbsrvname':
    case 'gsslib':
    case 'service':
    case 'target_session_attrs':
    case 'load_balance_hosts':
    case 'fallback_application_name':
    case 'keepalives':
    case 'keepalives_idle':
    case 'keepalives_interval':
    case 'keepalives_count':
      return;
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

const normalizeChannelBinding = (
  raw: string | null,
): ConnectOptions['channelBinding'] => {
  const value = (raw ?? '').toLowerCase();
  switch (value) {
    case 'disable':
    case 'prefer':
    case 'require':
      return value;
    default:
      return undefined;
  }
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
