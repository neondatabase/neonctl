/**
 * Connection backslash commands.
 *
 * TypeScript port of the corresponding `exec_command_*` functions in
 * upstream PostgreSQL's `src/bin/psql/command.c`:
 *
 *   - `\c` / `\connect`  → exec_command_connect / do_connect
 *   - `\conninfo`        → exec_command_conninfo
 *   - `\encoding`        → exec_command_encoding
 *   - `\password`        → exec_command_password
 *
 * What this module owns:
 *
 *   - Parsing the three `\c` argument shapes — positional (`db user host
 *     port`, with `-` meaning "keep current"), URI (`postgresql://…`), and
 *     conninfo key=value pairs (`dbname=foo host=bar`).
 *   - Building a fresh {@link ConnectOptions} by merging the override with
 *     the previous connection's opts and dispatching `PgConnection.connect`
 *     via an injectable seam so tests can stub the wire layer.
 *   - `\conninfo` — renders the PostgreSQL 18 "Connection Information"
 *     two-column table (Parameter / Value), mirroring upstream
 *     `exec_command_conninfo` in `src/bin/psql/command.c`. PG 18 rewrote
 *     `\conninfo` from the old one-line "You are connected to …" message
 *     into this table. Every value comes from the live connection's
 *     accessors (`getConnectionInfo()`, `getTlsInfo()`,
 *     `parameterStatus()`) — we issue NO SQL (the old form's
 *     `inet_server_addr()` returned a bogus internal IP behind a proxy like
 *     Neon). The ResultSet is handed to the active `\pset format` printer
 *     so `\conninfo` honours `-A`, `-H`, etc. just like a query result.
 *   - `\encoding` — like cmd_format.ts but additionally issues
 *     `SET client_encoding TO …` on the live connection so the backend
 *     ParameterStatus stays in sync with `settings.popt.topt.encoding`.
 *   - `\password` — prompts for a password (twice), encodes it as a
 *     SCRAM-SHA-256 verifier (RFC 5803 / PG's `ALTER USER … PASSWORD`
 *     format), and issues the ALTER USER on the live connection. The
 *     encoder lives in {@link scramSha256Verifier}; tests call it directly
 *     with a fixed salt so we don't have to mock crypto.randomBytes.
 *     Refuses to prompt when `settings.notty` is true (matches the spirit
 *     of upstream — we don't yet wire `/dev/tty`, so notty would otherwise
 *     fight the mainloop's stdin reader).
 *
 * What this module does NOT own:
 *
 *   - Cataloguing the current database/user. These are populated by the
 *     startup WP into psql vars DBNAME/USER (and kept in sync by `\c`), so
 *     `\conninfo` reads them out of `settings.vars`, falling back to the
 *     connect-opts surfaced on the live connection. Host/port/hostaddr and
 *     the SSL facts come straight from the connection accessors.
 *
 * Password retention: `PgConnection` exposes the password captured at
 * connect time via a read-only `password` getter (mirroring libpq's
 * retention on the `PGconn`). `\c` reads it via a structural cast so we
 * don't have to widen the frozen {@link Connection} interface, and feeds
 * it to {@link mergeConnectOpts} so a reconnect to a different database
 * works without re-prompting. A new password supplied in the conninfo /
 * URI override always wins.
 */

import { Buffer } from 'node:buffer';
import {
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes as nodeRandomBytes,
} from 'node:crypto';
import type {
  BackslashCmdSpec,
  BackslashContext,
  BackslashRegistry,
  BackslashResult,
} from '../types/backslash.js';
import type {
  Connection,
  ConnectOptions,
  FieldDescription,
  ResultSet,
} from '../types/connection.js';
import type { Printer, PrintQueryOpts } from '../types/printer.js';
import type { PsqlSettings } from '../types/settings.js';

import { readLine as readInputLine } from '../io/input.js';
import { syncConnectionVars } from '../core/syncVars.js';
import { PgConnection } from '../wire/connection.js';

import { alignedPrinter } from '../print/aligned.js';
import { asciidocPrinter } from '../print/asciidoc.js';
import { csvPrinter } from '../print/csv.js';
import { htmlPrinter } from '../print/html.js';
import { jsonPrinter } from '../print/json.js';
import { latexLongtablePrinter, latexPrinter } from '../print/latex.js';
import { troffMsPrinter } from '../print/troff.js';
import { unalignedPrinter } from '../print/unaligned.js';

import { writeErr, writeOut } from './shared.js';

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/**
 * Dependencies that the four command specs reach for at runtime. Exposed as
 * a module-level mutable so tests can swap in fakes without monkey-patching
 * the `node:readline` / wire layer. Production code never touches this; it
 * uses the defaults below.
 */
export type CmdConnectDeps = {
  /** Connect to a Postgres server. Default: `PgConnection.connect`. */
  connect: (opts: ConnectOptions) => Promise<Connection>;
  /** Read a single line (with optional echo suppression). Default: readline. */
  readLine: (prompt: string, opts: { echo: boolean }) => Promise<string>;
  /** Source of randomness for SCRAM salt generation. Default: node:crypto. */
  randomBytes: (n: number) => Buffer;
};

const defaultDeps: CmdConnectDeps = {
  connect: (opts) => PgConnection.connect(opts),
  readLine: defaultReadLine,
  randomBytes: nodeRandomBytes,
};

let currentDeps: CmdConnectDeps = defaultDeps;

/** Override the module's runtime deps. Returns a restore function. */
export const setCmdConnectDeps = (
  overrides: Partial<CmdConnectDeps>,
): (() => void) => {
  const prev = currentDeps;
  currentDeps = { ...prev, ...overrides };
  return () => {
    currentDeps = prev;
  };
};

// ---------------------------------------------------------------------------
// Password retention helper.
//
// `PgConnection` exposes a public read-only `password` getter; consumers that
// only see the frozen {@link Connection} interface reach for it via a
// structural cast (same shape as the `txStatus` / `lastCopyTag` accessors
// used elsewhere). Returns `null` when the connection is absent or the field
// isn't populated (mock connections in tests, future drivers, etc.).
// ---------------------------------------------------------------------------

type ConnWithPassword = { password?: string | null };

const readConnectionPassword = (conn: Connection | null): string | null => {
  if (!conn) return null;
  const raw = (conn as unknown as ConnWithPassword).password;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

type ConnWithOpts = { opts?: ConnectOptions };

/**
 * Read the live connection's EFFECTIVE {@link ConnectOptions} (the full set
 * it was dialled with — sslmode, sslrootcert/cert/key/crl, sslnegotiation,
 * channelBinding, requireAuth, hostaddr, …). The {@link Connection} interface
 * deliberately hides these, but {@link PgConnection} keeps them on a (TS-)
 * private `opts` field; we read it structurally, the same pattern as
 * {@link readConnectionPassword}. Used to SEED a `\c` reconnect so it doesn't
 * silently drop TLS/cert options or downgrade sslmode (review item #5).
 * Returns `null` for a mock/absent connection.
 */
const readConnectionOptions = (
  conn: Connection | null,
): ConnectOptions | null => {
  if (!conn) return null;
  const raw = (conn as unknown as ConnWithOpts).opts;
  return raw !== undefined && raw !== null && typeof raw === 'object'
    ? raw
    : null;
};

// ---------------------------------------------------------------------------
// \c / \connect
// ---------------------------------------------------------------------------

const KEEP = '-';

/**
 * Parse the argument tail of `\c` into a partial override of
 * {@link ConnectOptions}. Three forms:
 *
 *   1. **URI**: starts with `postgresql://` or `postgres://`.
 *   2. **conninfo**: contains `=` in the first token — treated as a space
 *      separated `key=value` sequence (libpq's syntax; we don't implement
 *      quoted values because psql itself only forwards what the user typed
 *      to libpq's `PQconninfoParse`).
 *   3. **positional**: `[db [user [host [port]]]]`. Each can be `-` to keep
 *      the current value.
 *
 * Returns an object with only the keys the user supplied. The caller is
 * responsible for merging with the previous opts.
 */
export const parseConnectArgs = (
  rawArgs: string,
): Partial<ConnectOptions> | { error: string } => {
  const trimmed = rawArgs.trim();
  if (trimmed.length === 0) return {};

  // URI form.
  if (
    trimmed.startsWith('postgresql://') ||
    trimmed.startsWith('postgres://')
  ) {
    return parseUri(trimmed);
  }

  // conninfo form — at least one token contains `=` (and that `=` is not
  // inside a quoted SQL value).
  if (
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed) ||
    /\s[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)
  ) {
    return parseConninfo(trimmed);
  }

  // Positional. Tokenise by whitespace; `-` is a sentinel.
  const tokens = trimmed.split(/\s+/);
  const out: Partial<ConnectOptions> = {};
  if (tokens.length >= 1 && tokens[0] !== KEEP) out.database = tokens[0];
  if (tokens.length >= 2 && tokens[1] !== KEEP) out.user = tokens[1];
  if (tokens.length >= 3 && tokens[2] !== KEEP) out.host = tokens[2];
  if (tokens.length >= 4 && tokens[3] !== KEEP) {
    const port = parseInt(tokens[3], 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      return { error: `invalid port number "${tokens[3]}"` };
    }
    out.port = port;
  }
  return out;
};

const parseUri = (raw: string): Partial<ConnectOptions> | { error: string } => {
  let url: URL;
  try {
    // Node's URL parser accepts `postgresql://` schemes.
    url = new URL(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `invalid URI: ${msg}` };
  }
  const out: Partial<ConnectOptions> = {};
  if (url.hostname.length > 0) out.host = decodeURIComponent(url.hostname);
  if (url.port.length > 0) {
    const port = parseInt(url.port, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      return { error: `invalid port in URI` };
    }
    out.port = port;
  }
  if (url.username.length > 0) out.user = decodeURIComponent(url.username);
  if (url.password.length > 0) {
    out.password = decodeURIComponent(url.password);
  }
  const pathname = url.pathname.replace(/^\//, '');
  if (pathname.length > 0) out.database = decodeURIComponent(pathname);
  return out;
};

const parseConninfo = (
  raw: string,
): Partial<ConnectOptions> | { error: string } => {
  const out: Partial<ConnectOptions> = {};
  // Simple key=value tokenizer — splits on whitespace not inside single
  // quotes. libpq supports backslash-escapes inside quotes; we accept them
  // verbatim for now (none of the keys we care about typically need them).
  const pairs: string[] = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inQuote) {
      if (c === '\\' && i + 1 < raw.length) {
        current += raw[i + 1];
        i++;
        continue;
      }
      if (c === "'") {
        inQuote = false;
        continue;
      }
      current += c;
      continue;
    }
    if (c === "'") {
      inQuote = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (current.length > 0) {
        pairs.push(current);
        current = '';
      }
      continue;
    }
    current += c;
  }
  if (current.length > 0) pairs.push(current);

  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 0) {
      return { error: `missing "=" after "${pair}" in connection info` };
    }
    const key = pair.slice(0, eq).toLowerCase();
    const value = pair.slice(eq + 1);
    switch (key) {
      case 'host':
        out.host = value;
        break;
      case 'hostaddr':
        // Distinct from `host`: hostaddr is the literal IP to dial, while the
        // cert/SNI is still verified against `host` (review item #10).
        out.hostaddr = value;
        break;
      case 'port': {
        const port = parseInt(value, 10);
        if (!Number.isFinite(port) || port <= 0 || port > 65535) {
          return { error: `invalid port "${value}"` };
        }
        out.port = port;
        break;
      }
      case 'user':
        out.user = value;
        break;
      case 'password':
        out.password = value;
        break;
      case 'dbname':
      case 'database':
        out.database = value;
        break;
      case 'application_name':
        out.applicationName = value;
        break;
      case 'sslmode': {
        const allowed: ConnectOptions['ssl'][] = [
          'disable',
          'allow',
          'prefer',
          'require',
          'verify-ca',
          'verify-full',
        ];
        if (!allowed.includes(value as ConnectOptions['ssl'])) {
          return { error: `invalid sslmode "${value}"` };
        }
        out.ssl = value as ConnectOptions['ssl'];
        break;
      }
      case 'channel_binding': {
        const allowed: NonNullable<ConnectOptions['channelBinding']>[] = [
          'disable',
          'prefer',
          'require',
        ];
        if (
          !allowed.includes(
            value as NonNullable<ConnectOptions['channelBinding']>,
          )
        ) {
          return { error: `invalid channel_binding "${value}"` };
        }
        out.channelBinding = value as NonNullable<
          ConnectOptions['channelBinding']
        >;
        break;
      }
      case 'client_encoding':
        out.clientEncoding = value;
        break;
      case 'connect_timeout': {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n) || n < 0) {
          return { error: `invalid connect_timeout "${value}"` };
        }
        out.connectTimeoutMs = n * 1000;
        break;
      }
      case 'options':
        out.options = value;
        break;
      default:
        // Unknown keys are silently ignored — matches libpq's permissiveness
        // for forward-compat with future PG releases. We could warn here,
        // but psql itself doesn't.
        break;
    }
  }
  return out;
};

/**
 * Build a full {@link ConnectOptions} for the new connection by merging
 * `override` over the "previous" connection state. The previous values are
 * sourced from `settings.vars` (HOST/PORT/USER/DBNAME/PASSWORD) which the
 * startup WP populates; for fields not represented there (sslmode, etc.)
 * we use safe defaults.
 *
 * For passwords specifically the precedence is:
 *   1. `override.password` — anything the user typed in this `\c` invocation
 *      (URI password or `password=` conninfo key) wins.
 *   2. `previousPassword` — the password captured on the live
 *      {@link PgConnection}, mirroring libpq's behaviour of retaining the
 *      credential on the `PGconn` so reconnects work transparently.
 *   3. `PASSWORD` psql var — set by `-W` / `PGPASSWORD` at startup.
 *
 * Returns `null` if the merge can't produce a usable opts (e.g. no database
 * and no current connection).
 */
export const mergeConnectOpts = (
  settings: PsqlSettings,
  override: Partial<ConnectOptions>,
  prior: Partial<ConnectOptions> | null = null,
): ConnectOptions | { error: string } => {
  const vars = settings.vars;

  // Overlay only the keys the user actually supplied (drop `undefined`s so a
  // spread doesn't clobber a seeded value with `undefined`).
  const ov: Partial<ConnectOptions> = {};
  for (const [k, v] of Object.entries(override)) {
    if (v !== undefined) (ov as Record<string, unknown>)[k] = v;
  }

  // libpq's do_connect clones the prior connection's full conninfo and
  // overrides only user-specified keys — so a reconnect keeps sslmode,
  // sslrootcert/cert/key/crl, sslnegotiation, channelBinding, requireAuth,
  // hostaddr, etc. (review item #5). Seed from the live connection's
  // effective options; fall back to {} when there is none.
  const seed: Partial<ConnectOptions> = prior ? { ...prior } : {};

  // libpq clears keep_password when user, host, OR port changes, so a stored
  // credential isn't transmitted to a different principal/server (review
  // item #4). Compare the override against the prior live target.
  const hostChanged = ov.host !== undefined && ov.host !== prior?.host;
  const targetChanged =
    hostChanged ||
    (ov.port !== undefined && ov.port !== prior?.port) ||
    (ov.user !== undefined && ov.user !== prior?.user);
  if (targetChanged) delete seed.password;
  // A new host invalidates the prior hostaddr (it was the old host's IP).
  if (hostChanged) delete seed.hostaddr;

  const merged: Partial<ConnectOptions> = { ...seed, ...ov };

  // Fill the required fields from vars / env / defaults when neither the
  // override nor the prior connection supplied them.
  const host = merged.host ?? vars.get('HOST') ?? 'localhost';
  const portStr = vars.get('PORT');
  const port =
    merged.port ?? (portStr !== undefined ? parseInt(portStr, 10) : 5432);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { error: `invalid port number` };
  }
  const user =
    merged.user ??
    vars.get('USER') ??
    process.env.USER ??
    process.env.USERNAME ??
    '';
  if (user.length === 0) {
    return { error: 'no user name specified' };
  }
  const database = merged.database ?? vars.get('DBNAME') ?? user;
  const password = merged.password ?? vars.get('PASSWORD');
  const ssl = merged.ssl ?? 'prefer';

  return {
    ...merged,
    host,
    port,
    user,
    password: password ?? undefined,
    database,
    ssl,
    applicationName: merged.applicationName ?? vars.get('APPLICATION_NAME'),
    clientEncoding: merged.clientEncoding ?? settings.popt.topt.encoding,
  };
};

/** `\c` / `\connect` — reconnect, possibly to a different database/user/host. */
export const cmdConnect: BackslashCmdSpec = {
  name: 'c',
  aliases: ['connect'],
  argMode: 'whole-line',
  helpKey: 'c',
  run: async (ctx: BackslashContext): Promise<BackslashResult> => {
    const rawArgs = ctx.restOfLine();
    if (rawArgs.trim().length === 0) {
      // No args → print conninfo, matching upstream `do_connect` short
      // circuit.
      return runConninfo(ctx);
    }

    const parsed = parseConnectArgs(rawArgs);
    if ('error' in parsed) {
      writeErr(`\\${ctx.cmdName}: ${parsed.error}\n`);
      return { status: 'error' };
    }

    // Seed the reconnect from the live connection's EFFECTIVE options so TLS /
    // cert / auth settings survive (review #5) and the prior password is only
    // reused when the principal/server is unchanged (review #4). Both are read
    // structurally from PgConnection (the frozen Connection interface hides
    // them). readConnectionPassword stays as the fallback for mocks/drivers
    // that expose `password` but not `opts`.
    const priorOpts = readConnectionOptions(ctx.settings.db);
    const priorPw = readConnectionPassword(ctx.settings.db);
    const prior: Partial<ConnectOptions> | null =
      priorOpts ?? (priorPw !== null ? { password: priorPw } : null);
    const newOpts = mergeConnectOpts(ctx.settings, parsed, prior);
    if ('error' in newOpts) {
      writeErr(`\\${ctx.cmdName}: ${newOpts.error}\n`);
      return { status: 'error' };
    }

    let next: Connection;
    try {
      next = await currentDeps.connect(newOpts);
    } catch (err) {
      // psql keeps the old connection on failure.
      const msg = err instanceof Error ? err.message : String(err);
      writeErr(`\\${ctx.cmdName}: connection failed: ${msg}\n`);
      return { status: 'error' };
    }

    const old = ctx.settings.db;
    ctx.settings.db = next;
    // Mirror upstream do_connect → SyncVariables(): refresh the
    // connection-driven psql vars (DBNAME/USER/HOST/PORT/ENCODING/
    // SERVER_VERSION_*) from the new live connection so subsequent
    // `:DBNAME`/`:USER`/etc. interpolations reflect the reconnect target.
    syncConnectionVars(ctx.settings.vars, next);

    if (old && !old.isClosed()) {
      try {
        await old.close();
      } catch {
        // Old connection may already be in a weird state; we've moved on.
      }
    }

    writeOut(
      `You are now connected to database "${newOpts.database}" as user "${newOpts.user}".\n`,
    );
    return { status: 'ok' };
  },
};

// ---------------------------------------------------------------------------
// \conninfo
// ---------------------------------------------------------------------------

/**
 * Pick the printer for the active output format. Mirrors the private
 * `pickPrinter` in `core/common.ts` / `pickActivePrinter` in `cmd_io.ts`
 * — replicated here (those are module-private) to avoid an import cycle,
 * the same established pattern this codebase already uses for the two
 * other copies.
 */
const pickActivePrinter = (settings: PsqlSettings): Printer => {
  switch (settings.popt.topt.format) {
    case 'aligned':
    case 'wrapped':
      return alignedPrinter;
    case 'unaligned':
      return unalignedPrinter;
    case 'csv':
      return csvPrinter;
    case 'json':
      return jsonPrinter;
    case 'html':
      return htmlPrinter;
    case 'asciidoc':
      return asciidocPrinter;
    case 'latex':
      return latexPrinter;
    case 'latex-longtable':
      return latexLongtablePrinter;
    case 'troff-ms':
      return troffMsPrinter;
    default:
      return alignedPrinter;
  }
};

/** A text-typed field descriptor for the synthetic conninfo ResultSet. */
const textField = (name: string): FieldDescription => ({
  name,
  tableID: 0,
  columnID: 0,
  // OID 25 = `text`: left-aligned, like both columns of upstream's output.
  dataTypeID: 25,
  dataTypeSize: -1,
  dataTypeModifier: -1,
  format: 0,
});

/**
 * Build the (Parameter, Value) rows for the PG18 connection-information
 * table. Mirrors the row order and gating of upstream
 * `exec_command_conninfo` (`src/bin/psql/command.c`).
 */
const buildConninfoRows = (
  ctx: BackslashContext,
  db: Connection,
): [string, string][] => {
  const info = db.getConnectionInfo?.() ?? null;
  const tls = db.getTlsInfo?.() ?? null;

  // Database / user come from the psql vars the startup WP populates (and
  // that `\c` keeps in sync); fall back to the connect-opts surfaced on the
  // connection when a var is missing.
  const database =
    ctx.settings.vars.get('DBNAME') ??
    (db as unknown as { database?: string }).database ??
    '';
  const user =
    ctx.settings.vars.get('USER') ??
    (db as unknown as { user?: string }).user ??
    '';

  const host = info?.host ?? ctx.settings.vars.get('HOST') ?? '';
  const hostaddr = info?.hostaddr ?? null;
  const port =
    info?.port ?? Number(ctx.settings.vars.get('PORT') ?? Number.NaN);
  const portStr = Number.isFinite(port) ? String(port) : '';

  const rows: [string, string][] = [];
  rows.push(['Database', database]);
  rows.push(['Client User', user]);

  // Host rows. A Unix-domain socket path (starts with '/') prints a
  // "Socket Directory" (or "Host Address" when a hostaddr was fixed);
  // otherwise "Host", plus a separate "Host Address" only when a distinct
  // hostaddr is present.
  if (host.startsWith('/')) {
    if (hostaddr !== null && hostaddr.length > 0) {
      rows.push(['Host Address', hostaddr]);
    } else {
      rows.push(['Socket Directory', host]);
    }
  } else {
    rows.push(['Host', host]);
    if (hostaddr !== null && hostaddr.length > 0 && hostaddr !== host) {
      rows.push(['Host Address', hostaddr]);
    }
  }

  rows.push(['Server Port', portStr]);
  rows.push(['Options', info?.options ?? '']);
  rows.push(['Protocol Version', '3.0']);
  rows.push(['Password Used', info?.passwordUsed ? 'true' : 'false']);
  rows.push(['GSSAPI Authenticated', info?.gssapiUsed ? 'true' : 'false']);
  rows.push(['Backend PID', String(info?.backendPid ?? 0)]);
  rows.push(['SSL Connection', tls ? 'true' : 'false']);

  if (tls) {
    rows.push(['SSL Library', tls.library]);
    rows.push(['SSL Protocol', tls.protocol]);
    rows.push([
      'SSL Key Bits',
      tls.keyBits !== null ? String(tls.keyBits) : '',
    ]);
    rows.push(['SSL Cipher', tls.cipher]);
    rows.push([
      'SSL Compression',
      tls.compression !== 'off' ? 'true' : 'false',
    ]);
    rows.push(['ALPN', tls.alpn && tls.alpn.length > 0 ? tls.alpn : 'none']);
  }

  rows.push([
    'Superuser',
    ctx.settings.db?.parameterStatus('is_superuser') ?? 'unknown',
  ]);
  rows.push([
    'Hot Standby',
    ctx.settings.db?.parameterStatus('in_hot_standby') ?? 'unknown',
  ]);

  return rows;
};

const runConninfo = async (ctx: BackslashContext): Promise<BackslashResult> => {
  const db = ctx.settings.db;
  if (!db) {
    writeOut('You are currently not connected to a database.\n');
    return { status: 'ok' };
  }

  const rows = buildConninfoRows(ctx, db);
  const rs: ResultSet = {
    command: 'SELECT',
    rowCount: rows.length,
    oid: null,
    fields: [textField('Parameter'), textField('Value')],
    rows: rows.map(([p, v]) => [p, v]),
    notices: [],
  };

  // Render with the active printer (honours `\pset format`), titled
  // "Connection Information" with the default `(N rows)` footer left on,
  // matching PG18's `printQuery(... title = "Connection Information")`.
  const popt: PrintQueryOpts = {
    ...ctx.settings.popt,
    title: 'Connection Information',
    topt: {
      ...ctx.settings.popt.topt,
      title: 'Connection Information',
      defaultFooter: true,
    },
  };
  const out = process.stdout;
  await pickActivePrinter(ctx.settings).printQuery(rs, popt, out);
  return { status: 'ok' };
};

/** `\conninfo` — print info about the current connection. */
export const cmdConninfo: BackslashCmdSpec = {
  name: 'conninfo',
  helpKey: 'conninfo',
  run: (ctx: BackslashContext): Promise<BackslashResult> => runConninfo(ctx),
};

// ---------------------------------------------------------------------------
// \encoding — overrides cmd_format.ts's version so the live connection
// also sees the new client_encoding (via SET client_encoding TO …).
// ---------------------------------------------------------------------------

/** `\encoding [NAME]` — show or set the client encoding, propagating to the connection. */
export const cmdEncoding: BackslashCmdSpec = {
  name: 'encoding',
  helpKey: 'encoding',
  run: async (ctx: BackslashContext): Promise<BackslashResult> => {
    const arg = ctx.nextArg('normal');
    const topt = ctx.settings.popt.topt;
    if (arg === null) {
      writeOut(`${topt.encoding}\n`);
      return { status: 'ok' };
    }

    const db = ctx.settings.db;
    if (db && !db.isClosed()) {
      try {
        // PG accepts both quoted and unquoted encoding names; we use the
        // quoted form for safety. Encoding names are ASCII identifiers.
        await db.execSimple(`SET client_encoding TO ${db.escapeLiteral(arg)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeErr(`\\${ctx.cmdName}: ${msg}\n`);
        return { status: 'error' };
      }
    }
    topt.encoding = arg;
    ctx.settings.vars.set('ENCODING', arg);
    return { status: 'ok' };
  },
};

// ---------------------------------------------------------------------------
// \password
// ---------------------------------------------------------------------------

/**
 * Encode a password into PostgreSQL's SCRAM-SHA-256 verifier format, the
 * value `ALTER ROLE … PASSWORD '…'` expects when the server is configured
 * with `password_encryption = scram-sha-256` (the default since PG 14):
 *
 *   SCRAM-SHA-256$<iterations>:<base64 salt>$<base64 storedKey>:<base64 serverKey>
 *
 * Derivation follows RFC 5802 §3:
 *
 *   SaltedPassword = PBKDF2-HMAC-SHA256(password, salt, iterations, 32)
 *   ClientKey      = HMAC-SHA256(SaltedPassword, "Client Key")
 *   StoredKey      = SHA256(ClientKey)
 *   ServerKey      = HMAC-SHA256(SaltedPassword, "Server Key")
 *
 * Sending the encoded form (rather than the plaintext password) means the
 * server never sees the password, even briefly, and the SCRAM verifier is
 * stored as-is in `pg_authid.rolpassword`.
 *
 * Iterations default to 4096 to match PG's `scram_iterations` default and
 * libpq's `PQchangePassword`. The caller can override (lower for tests,
 * higher for stronger hardening).
 */
export const scramSha256Verifier = (
  password: string,
  salt: Buffer,
  iterations = 4096,
): string => {
  const saltedPassword = pbkdf2Sync(
    Buffer.from(password, 'utf8'),
    salt,
    iterations,
    32,
    'sha256',
  );
  const clientKey = createHmac('sha256', saltedPassword)
    .update('Client Key')
    .digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', saltedPassword)
    .update('Server Key')
    .digest();
  return (
    'SCRAM-SHA-256$' +
    String(iterations) +
    ':' +
    salt.toString('base64') +
    '$' +
    storedKey.toString('base64') +
    ':' +
    serverKey.toString('base64')
  );
};

/**
 * Default password / prompt reader. Delegates to the shared input layer
 * ({@link readInputLine}), which suppresses echo on a TTY and falls back to a
 * plain line read otherwise. Kept as a named function so the test seam in
 * {@link CmdConnectDeps} can swap it out.
 */
function defaultReadLine(
  prompt: string,
  opts: { echo: boolean },
): Promise<string> {
  return readInputLine(prompt, { echo: opts.echo });
}

/** `\password [USERNAME]` — change a role's password, locally hashed as SCRAM. */
export const cmdPassword: BackslashCmdSpec = {
  name: 'password',
  helpKey: 'password',
  run: async (ctx: BackslashContext): Promise<BackslashResult> => {
    const db = ctx.settings.db;
    if (!db || db.isClosed()) {
      writeErr(`\\${ctx.cmdName}: not connected\n`);
      return { status: 'error' };
    }

    // Refuse to prompt for a password when stdin is not a TTY. Upstream uses
    // /dev/tty as a fallback so it works even with piped stdin; we don't yet
    // wire that path, so notty is a hard error (it would otherwise corrupt
    // the mainloop's own readline iterator on stdin). Tests mock the prompt
    // via `readLine` and run with `notty: false`, the `defaultSettings`
    // default.
    if (ctx.settings.notty) {
      writeErr(`\\${ctx.cmdName}: not in interactive mode\n`);
      return { status: 'error' };
    }

    const userArg = ctx.nextArg('sql-id');
    let user = userArg;
    if (user === null) {
      try {
        const rs = await db.query('SELECT CURRENT_USER');
        const row = rs.rows[0] ?? [];
        user = typeof row[0] === 'string' ? row[0] : null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeErr(`\\${ctx.cmdName}: ${msg}\n`);
        return { status: 'error' };
      }
      if (!user) {
        writeErr(`\\${ctx.cmdName}: could not determine current user\n`);
        return { status: 'error' };
      }
    }

    let pw1: string;
    let pw2: string;
    try {
      pw1 = await currentDeps.readLine(
        `Enter new password for user "${user}": `,
        { echo: false },
      );
      pw2 = await currentDeps.readLine('Enter it again: ', { echo: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeErr(`\\${ctx.cmdName}: ${msg}\n`);
      return { status: 'error' };
    }

    if (pw1 !== pw2) {
      writeErr(`\\${ctx.cmdName}: Passwords didn't match.\n`);
      return { status: 'error' };
    }
    if (pw1.length === 0) {
      writeErr(`\\${ctx.cmdName}: empty password\n`);
      return { status: 'error' };
    }

    // Match upstream's PQchangePassword: `ALTER USER <id> PASSWORD <lit>`.
    // (ALTER USER and ALTER ROLE are synonyms in PG, but we follow the
    // libpq spelling for byte-for-byte parity with vanilla psql.)
    const salt = currentDeps.randomBytes(16);
    const verifier = scramSha256Verifier(pw1, salt);
    const sql =
      'ALTER USER ' +
      db.escapeIdentifier(user) +
      ' PASSWORD ' +
      db.escapeLiteral(verifier);

    try {
      await db.execSimple(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeErr(`\\${ctx.cmdName}: ${msg}\n`);
      return { status: 'error' };
    }
    return { status: 'ok' };
  },
};

// ---------------------------------------------------------------------------
// Registry hook
// ---------------------------------------------------------------------------

/**
 * Register the four connection commands on the given registry. Called from
 * `dispatch.ts::defaultRegistry()`. Re-registering an existing primary name
 * overrides — that's how we replace the no-op `\encoding` from cmd_format
 * with this WP's version that propagates to the connection.
 */
export const registerConnectCommands = (registry: BackslashRegistry): void => {
  registry.register(cmdConnect);
  registry.register(cmdConninfo);
  registry.register(cmdEncoding);
  registry.register(cmdPassword);
};
