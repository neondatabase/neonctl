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
 *   - `\conninfo` — runs `SELECT current_database(), current_user,
 *     inet_server_addr(), inet_server_port()` and renders the upstream-style
 *     "You are connected to …" line. This diverges from modern psql which
 *     prints a full key/value table; the simpler line form is what the WP
 *     contract specifies and matches pre-17 psql.
 *   - `\encoding` — like cmd_format.ts but additionally issues
 *     `SET client_encoding TO …` on the live connection so the backend
 *     ParameterStatus stays in sync with `settings.popt.topt.encoding`.
 *   - `\password` — prompts for a password (twice), encodes it as a
 *     SCRAM-SHA-256 verifier (RFC 5803 / PG's `ALTER ROLE … PASSWORD`
 *     format), and issues the ALTER ROLE on the live connection. The
 *     encoder lives in {@link scramSha256Verifier}; tests call it directly
 *     with a fixed salt so we don't have to mock crypto.randomBytes.
 *
 * What this module does NOT own:
 *
 *   - Storing the password in memory after the initial connect. The
 *     `Connection` interface (WP-00) deliberately does not expose the
 *     credential, and we can't modify `PgConnection` from here (WP-02
 *     deliverable, frozen). On reconnect we read the password from the
 *     psql `PASSWORD` variable if set; otherwise we try the connect with
 *     no password and let it fail if the server demands one. A future WP
 *     can plumb secure password retention through the {@link Connection}
 *     contract.
 *   - Cataloguing the current host/port/user/database. These are populated
 *     by the startup WP into psql vars HOST/PORT/USER/DBNAME (and so are
 *     read out of `settings.vars` here). When those vars are missing we
 *     query SQL or fall back to opt defaults, accepting that `\conninfo`
 *     will then report whatever the server reports.
 */

import { Buffer } from 'node:buffer';
import {
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes as nodeRandomBytes,
} from 'node:crypto';
import { createInterface } from 'node:readline';

import type {
  BackslashCmdSpec,
  BackslashContext,
  BackslashRegistry,
  BackslashResult,
} from '../types/backslash.js';
import type { Connection, ConnectOptions } from '../types/connection.js';
import type { PsqlSettings } from '../types/settings.js';

import { PgConnection } from '../wire/connection.js';

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
      case 'hostaddr':
        out.host = value;
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
 * Returns `null` if the merge can't produce a usable opts (e.g. no database
 * and no current connection).
 */
export const mergeConnectOpts = (
  settings: PsqlSettings,
  override: Partial<ConnectOptions>,
): ConnectOptions | { error: string } => {
  const vars = settings.vars;
  const host = override.host ?? vars.get('HOST') ?? 'localhost';
  const portStr = vars.get('PORT');
  const port =
    override.port ?? (portStr !== undefined ? parseInt(portStr, 10) : 5432);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { error: `invalid port number` };
  }
  const user =
    override.user ??
    vars.get('USER') ??
    process.env.USER ??
    process.env.USERNAME ??
    '';
  if (user.length === 0) {
    return { error: 'no user name specified' };
  }
  const database = override.database ?? vars.get('DBNAME') ?? user;
  // Password: explicit override wins; otherwise read from psql var
  // PASSWORD (set by the startup WP via -W / PGPASSWORD), else undefined.
  const password = override.password ?? vars.get('PASSWORD');
  const ssl =
    override.ssl ??
    (vars.get('SSLMODE') as ConnectOptions['ssl'] | undefined) ??
    'prefer';
  return {
    host,
    port,
    user,
    password,
    database,
    ssl,
    applicationName: override.applicationName ?? vars.get('APPLICATION_NAME'),
    channelBinding: override.channelBinding,
    connectTimeoutMs: override.connectTimeoutMs,
    clientEncoding: override.clientEncoding ?? settings.popt.topt.encoding,
    options: override.options,
  };
};

/** Apply the post-connect housekeeping psql does: update HOST/PORT/etc. */
const writeConnectVars = (
  settings: PsqlSettings,
  opts: ConnectOptions,
): void => {
  settings.vars.set('HOST', opts.host);
  settings.vars.set('PORT', String(opts.port));
  settings.vars.set('USER', opts.user);
  settings.vars.set('DBNAME', opts.database);
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

    const newOpts = mergeConnectOpts(ctx.settings, parsed);
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
    writeConnectVars(ctx.settings, newOpts);

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

const runConninfo = async (ctx: BackslashContext): Promise<BackslashResult> => {
  const db = ctx.settings.db;
  if (!db) {
    writeOut('You are currently not connected to a database.\n');
    return { status: 'ok' };
  }

  // Pull what we can from psql vars (set by \c or by startup). For the rest
  // we run a one-shot SQL query.
  let database = ctx.settings.vars.get('DBNAME');
  let user = ctx.settings.vars.get('USER');
  let host = ctx.settings.vars.get('HOST');
  let port = ctx.settings.vars.get('PORT');

  if (!database || !user) {
    try {
      const rs = await db.query(
        'SELECT current_database(), current_user, inet_server_addr()::text, inet_server_port()::text',
      );
      const row = rs.rows[0] ?? [];
      database = database ?? (typeof row[0] === 'string' ? row[0] : undefined);
      user = user ?? (typeof row[1] === 'string' ? row[1] : undefined);
      host = host ?? (typeof row[2] === 'string' ? row[2] : undefined);
      port = port ?? (typeof row[3] === 'string' ? row[3] : undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeErr(`\\${ctx.cmdName}: ${msg}\n`);
      return { status: 'error' };
    }
  }

  const dbStr = database ?? '?';
  const userStr = user ?? '?';
  const portStr = port ?? '?';

  if (host !== undefined && host.length > 0 && host.startsWith('/')) {
    writeOut(
      `You are connected to database "${dbStr}" as user "${userStr}" via socket in "${host}" at port "${portStr}".\n`,
    );
  } else {
    const hostStr = host ?? '?';
    writeOut(
      `You are connected to database "${dbStr}" as user "${userStr}" on host "${hostStr}" at port "${portStr}".\n`,
    );
  }
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

async function defaultReadLine(
  prompt: string,
  opts: { echo: boolean },
): Promise<string> {
  // TODO(WP-24): hook into the line editor once it lands so we can suppress
  // echo natively. For now we read a full line; on a TTY this echoes, which
  // is a leak we accept until WP-24. `echo: false` is honoured on a best
  // effort basis by toggling raw mode if the stdin is a TTY.
  const isTty =
    process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';
  if (!opts.echo && isTty) {
    return readPasswordTty(prompt);
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: false,
  });
  try {
    return await new Promise<string>((resolve) => {
      if (prompt.length > 0) process.stderr.write(prompt);
      rl.once('line', (l) => {
        resolve(l);
      });
      rl.once('close', () => {
        resolve('');
      });
    });
  } finally {
    rl.close();
  }
}

function readPasswordTty(prompt: string): Promise<string> {
  return new Promise<string>((resolve) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === '') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '') {
          // Ctrl-C: cancel, fail silently.
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write('\n');
          resolve('');
          return;
        }
        if (ch === '' || ch === '\b') {
          // Backspace.
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
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

    const salt = currentDeps.randomBytes(16);
    const verifier = scramSha256Verifier(pw1, salt);
    const sql =
      'ALTER ROLE ' +
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
