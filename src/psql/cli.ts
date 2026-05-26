#!/usr/bin/env node

/**
 * Standalone psql shim.
 *
 * Thin wrapper around `runPsql` that lets the conformance harness — and any
 * caller that wants a psql-compatible CLI — invoke our embedded TypeScript
 * psql directly via `node dist/psql/cli.js`, without going through the
 * neonctl yargs entrypoint.
 *
 * Why this exists: `dist/cli.js` is the neonctl entrypoint; yargs eats
 * libpq-style flags (e.g. `-v ON_ERROR_STOP=0` collides with yargs'
 * built-in `--version`). The conformance suite needs to spawn a binary
 * that accepts the upstream psql flag grammar (`-h`/`-p`/`-U`/`-d`/`-X`/
 * `-v VAR=VALUE`/`--no-psqlrc`/`--echo-all`/`--quiet`/etc.) and reads SQL
 * from stdin. This shim wires `process.argv.slice(2)` straight into
 * `runPsql`, which already speaks that grammar via `parseStartupArgs`.
 *
 * Argv shape:
 *   - If the first positional looks like a connection URI / conninfo
 *     (per `looksLikeConnectionString`), it stays at argv[0] — same shape
 *     as the legacy native-psql call site in `src/utils/psql.ts` and the
 *     existing `runPsql` API.
 *   - Otherwise (the regress harness case: bare libpq flags), we prepend
 *     an empty placeholder URI so `runPsql([''] + flags)` falls through to
 *     `parseStartupArgs` and resolves the connection from `-h`/`-p`/`-U`/
 *     `-d` plus PG* env / pgpass / service via the layered resolver.
 *
 * Exit code: forwarded straight from `runPsql` (matches upstream psql's
 * EXIT_SUCCESS / EXIT_FAILURE / EXIT_USER / EXIT_BADCONN values; see
 * `core/mainloop.ts`).
 */

import { runPsql, looksLikeConnectionString } from './index.js';

const main = async (): Promise<void> => {
  const raw = process.argv.slice(2);

  // Detect whether the first arg is a connection URI/conninfo string.
  // libpq's `recognized_connection_string()` covers both `postgres[ql]://…`
  // URIs and bare `key=value` conninfo strings — `looksLikeConnectionString`
  // mirrors that test.
  const argv =
    raw.length > 0 && looksLikeConnectionString(raw[0]) ? raw : ['', ...raw];

  const code = await runPsql(argv, {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exit(code);
};

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`psql: fatal: ${msg}\n`);
  process.exit(1);
});
