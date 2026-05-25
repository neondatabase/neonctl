import type { ConnectOptions } from './types/connection.js';
import type { REPLContext, Stdio } from './types/repl.js';

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
      let status: number = EXIT_SUCCESS;
      for (const action of preActions) {
        if (action.kind === 'command') {
          try {
            await executeInputString(action.sql, ctx);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            stderr.write(`psql: ERROR:  ${msg}\n`);
            status = EXIT_USER;
            if (settings.onErrorStop) break;
          }
        } else {
          // -f: file.
          try {
            const contents = await fs.readFile(action.path, 'utf8');
            await executeInputString(contents, ctx);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            stderr.write(`psql: error: ${msg}\n`);
            status = EXIT_FAILURE;
            if (settings.onErrorStop) break;
          }
        }
      }
      return status;
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
  // Strip scheme.
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
    const key = decodePercent(eq < 0 ? segment : segment.slice(0, eq)).trim();
    const value = eq < 0 ? '' : decodePercent(segment.slice(eq + 1)).trim();
    if (key === '') continue;
    out.set(key, value);
  }
  return out;
};

const decodePercent = (s: string): string => {
  // decodeURIComponent treats '+' as literal '+', which matches libpq.
  // Keeps malformed escapes (which we don't currently validate) as-is.
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
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
  };
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
