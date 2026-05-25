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

const parseConnectionUri = (uri: string): ConnectOptions => {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(`unsupported scheme: ${parsed.protocol}`);
  }

  const host = parsed.hostname || 'localhost';
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 5432;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port: ${parsed.port}`);
  }

  const user = decodeURIComponent(parsed.username || process.env.USER || '');
  const password = parsed.password
    ? decodeURIComponent(parsed.password)
    : undefined;
  const database =
    decodeURIComponent(parsed.pathname.replace(/^\//, '')) || user;

  const sslModeParam = parsed.searchParams.get('sslmode');
  const ssl = normalizeSslMode(sslModeParam);

  const channelBindingParam = parsed.searchParams.get('channel_binding');
  const channelBinding = normalizeChannelBinding(channelBindingParam);

  const options = parsed.searchParams.get('options') ?? undefined;
  const applicationName =
    parsed.searchParams.get('application_name') ?? 'neonctl-psql';

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
