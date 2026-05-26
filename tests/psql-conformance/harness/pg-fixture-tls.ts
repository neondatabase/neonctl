// Opt-in TLS-enabled Postgres fixture for the conformance harness.
//
// This is a sibling of `pg-fixture.ts` that boots a separate postgres
// container with `ssl=on` and a self-signed server cert. It is used only
// by tap/005_negotiate_encryption.spec.ts; the shared plaintext fixture
// from `pg-fixture.ts` is unaffected.
//
// Each call to `setupTlsPg()` boots a fresh container (no caching across
// tests) because the negotiation tests need to toggle server SSL state by
// reaching for a different fixture instance. `teardownTlsPg()` stops the
// container and frees the tmp dir.
//
// The fixture also lays down a custom `pg_hba.conf` so the suite can
// exercise the upstream `hostssl` / `hostnossl` / `host` rules. Three
// users are pre-created in `beforeAll`:
//
//   - `testuser`  — `host all testuser ...` (default, plaintext or SSL)
//   - `ssluser`   — `hostssl all ssluser ...` (TLS required)
//   - `nossluser` — `hostnossl all nossluser ...` (TLS forbidden)
//
// Self-signed cert generation: we shell out to `openssl req -x509` rather
// than implement X.509 encoding in Node. The cert is RSA-2048, CN=localhost,
// 30 day lifetime, no SAN — adequate for `sslmode=require` (which doesn't
// check the chain) but NOT for `verify-ca` / `verify-full` (the cert is
// untrusted and the hostname isn't in the SAN).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { log } from './util-log.js';

export type TlsPgConn = {
  host: string;
  port: number;
  db: string;
  /**
   * Default `testuser` (host all all trust). Other usernames (`ssluser`,
   * `nossluser`) are created at startup and have different HBA rules — use
   * them by overriding `user` on the {@link PgConnection.connect} options.
   */
  user: string;
  password: string;
  /** Path to the self-signed CA / server cert on the host filesystem. */
  serverCertPath: string;
  /** Path to the private key on the host filesystem. */
  serverKeyPath: string;
  /** Working directory used for cert generation; cleaned up on teardown. */
  workDir: string;
};

type StoppableContainer = { stop(): Promise<unknown> };

let containerRef: StoppableContainer | null = null;
let workDirRef: string | null = null;

const PG_IMAGE_DEFAULT = 'postgres:18.0';

/**
 * Generate a self-signed RSA-2048 cert + key in `workDir`. Returns the
 * absolute paths to `server.crt` and `server.key`.
 *
 * Uses the host's `openssl` CLI; throws if `openssl` is not on PATH. The
 * spec is expected to detect this up-front and `it.skip` the suite when
 * the dependency is missing.
 */
export function generateSelfSignedCert(workDir: string): {
  certPath: string;
  keyPath: string;
} {
  const keyPath = join(workDir, 'server.key');
  const certPath = join(workDir, 'server.crt');
  // -nodes        : don't encrypt the key (postgres reads it at startup)
  // -newkey rsa:2048: generate a new key, RSA-2048
  // -keyout       : write key to file
  // -out          : write self-signed cert to file
  // -days 30      : 30-day lifetime is plenty for a test fixture
  // -subj         : skip the interactive prompt; CN=localhost
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-nodes',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '30',
      '-subj',
      '/CN=localhost',
    ],
    { stdio: 'pipe' },
  );
  return { certPath, keyPath };
}

/**
 * Init script that we drop into `/docker-entrypoint-initdb.d/`. The
 * postgres entrypoint runs every `.sql` file there after the cluster is
 * initialised but BEFORE the server starts accepting client traffic — so
 * the `CREATE USER` + `pg_hba.conf` rewrite are applied before the first
 * test connection.
 *
 * The `pg_hba.conf` content mirrors the upstream 005 test's setup,
 * narrowed to the rules our portable subset exercises:
 *
 *   - `host  all  testuser  0.0.0.0/0  trust`     (any auth, plaintext OR ssl)
 *   - `hostssl  all  ssluser  0.0.0.0/0  trust`   (ssl only)
 *   - `hostnossl  all  nossluser  0.0.0.0/0  trust` (plaintext only)
 *
 * Plus a final `host all all ... trust` catch-all so the default `postgres`
 * superuser still works (the harness's setup queries use it). The order is
 * important — pg_hba.conf is evaluated top-down and the first match wins.
 */
const INIT_SQL = `
-- Negotiation-encryption suite users. The pg_hba.conf rules below select
-- between them based on the negotiated transport (host = any; hostssl =
-- TLS only; hostnossl = plaintext only).
CREATE USER testuser;
CREATE USER ssluser;
CREATE USER nossluser;
`;

/**
 * pg_hba.conf used by the negotiate-encryption suite. Order matters —
 * postgres scans the file top-down and uses the FIRST matching rule.
 *
 *   - ssluser: only `hostssl` matches (plaintext rejected at the rule
 *     level with "no pg_hba.conf entry"). SSL connections accepted via
 *     trust.
 *   - nossluser: only `hostnossl` matches. SSL connections rejected.
 *   - testuser: `host` matches both encryptions.
 *   - The default superuser (`postgres` — name varies between docker
 *     images, but we use whatever testcontainers passed as
 *     POSTGRES_USER) keeps `local` + a `host all all` catch-all so the
 *     entrypoint's bootstrap continues to work AND so adminExec() can
 *     reach the cluster from the spec.
 *
 * IMPORTANT: the trailing `host all all 0.0.0.0/0 trust` rule MUST come
 * AFTER the user-specific `hostssl` / `hostnossl` rules, otherwise it
 * would catch ssluser / nossluser before their narrower rules fire and
 * the suite would silently misreport pass/fail.
 */
const HBA_CONF = `
# negotiate_encryption.spec.ts HBA — see pg-fixture-tls.ts.
# Order is significant: first matching rule wins.
# TYPE         DATABASE  USER       ADDRESS         METHOD
hostssl        all       ssluser    0.0.0.0/0       trust
hostssl        all       ssluser    ::/0            trust
hostnossl      all       nossluser  0.0.0.0/0       trust
hostnossl      all       nossluser  ::/0            trust
host           all       testuser   0.0.0.0/0       trust
host           all       testuser   ::/0            trust
# Default rules for the testcontainers superuser ("test" by default;
# both md5 and trust are accepted so the entrypoint bootstrap and the
# spec's adminExec helper both work).
local          all       all                        trust
host           all       test       0.0.0.0/0       trust
host           all       test       ::/0            trust
`;

/** Server-side path that the init script copies the cert to. */
const CERT_TARGET = '/etc/postgresql-tls/server.crt';
/** Server-side path that the init script copies the key to. */
const KEY_TARGET = '/etc/postgresql-tls/server.key';

/**
 * Init script that rewrites pg_hba.conf with the negotiation-encryption
 * ruleset AND enables SSL via postgresql.conf (NOT via the postmaster
 * command line, which would prevent `ALTER SYSTEM SET ssl=off` from
 * taking effect at runtime).
 *
 * Why a `.sh` init script and not `.sql`?
 *   - pg_hba.conf is a filesystem rewrite, not a SQL command.
 *   - The key file needs to be chowned to the postgres user and
 *     chmodded to 0600 before postgres will accept it (or postgres
 *     refuses to start with `permissions are too liberal`).
 *
 * The script:
 *   1. Copies the bind-mounted cert + key into the PGDATA dir so the
 *      file owner is the postgres user (avoids permission issues with
 *      bind-mounted host files owned by root).
 *   2. Sets restrictive perms on the key (0600).
 *   3. Appends `ssl=on` + `ssl_cert_file=` + `ssl_key_file=` to
 *      postgresql.conf so the setting is persistent but overridable by
 *      ALTER SYSTEM (which writes to postgresql.auto.conf, evaluated
 *      AFTER postgresql.conf).
 *   4. Rewrites pg_hba.conf with the suite's ruleset.
 *
 * The init script runs after `initdb` and BEFORE the server starts
 * accepting client connections, so all of this is in place by the time
 * the harness opens its first connection.
 */
const HBA_INIT_SH = `#!/bin/sh
set -eu

# Move the cert + key out of /tmp into PGDATA where they will be owned
# by the postgres user, then lock down the key permissions.
cp "${CERT_TARGET}" "$PGDATA/server.crt"
cp "${KEY_TARGET}" "$PGDATA/server.key"
chown postgres:postgres "$PGDATA/server.crt" "$PGDATA/server.key" || true
chmod 600 "$PGDATA/server.key"
chmod 644 "$PGDATA/server.crt"

# Enable SSL via postgresql.conf so it is the default but can be
# overridden at runtime via ALTER SYSTEM (which writes to
# postgresql.auto.conf, applied AFTER postgresql.conf).
cat >> "$PGDATA/postgresql.conf" <<'__CONF_EOF__'
# negotiate_encryption.spec.ts — TLS material loaded from PGDATA.
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
__CONF_EOF__

# Rewrite pg_hba.conf with the suite's narrow ruleset.
cat > "$PGDATA/pg_hba.conf" <<'__HBA_EOF__'
${HBA_CONF.trim()}
__HBA_EOF__
`;

/**
 * Boot a fresh postgres container with TLS enabled. Returns the connection
 * info plus the host-side cert paths so the test can validate them.
 */
export async function setupTlsPg(): Promise<TlsPgConn> {
  const workDir = mkdtempSync(join(tmpdir(), 'psql-conformance-tls-'));
  workDirRef = workDir;
  const { certPath, keyPath } = generateSelfSignedCert(workDir);
  const initSqlPath = join(workDir, 'init-users.sql');
  writeFileSync(initSqlPath, INIT_SQL, 'utf8');
  const initHbaPath = join(workDir, 'init-hba.sh');
  writeFileSync(initHbaPath, HBA_INIT_SH, { mode: 0o755 });

  // The testcontainers builder is fluent; every `with*` returns `this`.
  // We type it as one record because the dynamic import below cannot
  // give us the package's own (optional) types.
  //
  // We do NOT use the `withSSL` helper from @testcontainers/postgresql:
  // it injects `-c ssl=on` on the postmaster command line, which
  // overrides any later `ALTER SYSTEM SET ssl = 'off'` (command-line
  // GUCs win over postgresql.auto.conf). We need to toggle ssl at
  // runtime, so we mount the cert files and configure ssl in the data
  // dir via the init shell script instead.
  type ContentToCopy = {
    content: string;
    target: string;
    mode?: number;
  };
  type Builder = {
    withCopyFilesToContainer(
      files: { source: string; target: string; mode?: number }[],
    ): Builder;
    withCopyContentToContainer(contents: ContentToCopy[]): Builder;
    start(): Promise<StartedContainer>;
  };
  type StartedContainer = {
    stop(): Promise<void>;
    getHost(): string;
    getPort(): number;
    getDatabase(): string;
    getUsername(): string;
    getPassword(): string;
  };

  // Dynamic import so the harness still loads when @testcontainers/postgresql
  // is absent (mirrors pg-fixture.ts).
  const moduleName = '@testcontainers/postgresql';
  let mod: { PostgreSqlContainer?: unknown };
  try {
    mod = (await import(moduleName)) as { PostgreSqlContainer?: unknown };
  } catch {
    throw new Error(
      'pg-fixture-tls: @testcontainers/postgresql is not installed. ' +
        'Install with `bun add -d @testcontainers/postgresql` (one-time).',
    );
  }
  type ContainerCtor = new (image: string) => Builder;
  const ctor = mod.PostgreSqlContainer as ContainerCtor | undefined;
  if (typeof ctor !== 'function') {
    throw new Error(
      'pg-fixture-tls: @testcontainers/postgresql is installed but does not ' +
        'export PostgreSqlContainer — your version is incompatible.',
    );
  }
  const image = process.env.PGCONFORMANCE_PG_IMAGE ?? PG_IMAGE_DEFAULT;
  log(`pg-fixture-tls: booting ${image} with TLS enabled...`);
  const builder: Builder = new ctor(image).withCopyFilesToContainer([
    // Cert + key copied into a staging location, world-readable so the
    // entrypoint (which runs as the `postgres` user) can `cp` them into
    // PGDATA. The cert + key are throwaway test material — they live in
    // a tmp dir on the host, so loose perms here are not a security
    // concern. The init script chmods the in-PGDATA copy back to 0600.
    {
      source: certPath,
      target: CERT_TARGET,
      mode: 0o644,
    },
    {
      source: keyPath,
      target: KEY_TARGET,
      mode: 0o644,
    },
    // Init scripts run in alphabetical order — `01-users.sql` creates
    // the suite users via SQL; `02-hba.sh` then rewrites pg_hba.conf
    // and enables SSL via postgresql.conf.
    {
      source: initSqlPath,
      target: '/docker-entrypoint-initdb.d/01-users.sql',
      mode: 0o644,
    },
    {
      source: initHbaPath,
      target: '/docker-entrypoint-initdb.d/02-hba.sh',
      mode: 0o755,
    },
  ]);
  const started = await builder.start();
  containerRef = started;
  const conn: TlsPgConn = {
    host: started.getHost(),
    port: started.getPort(),
    db: started.getDatabase(),
    user: started.getUsername(),
    password: started.getPassword(),
    serverCertPath: certPath,
    serverKeyPath: keyPath,
    workDir,
  };
  log(`pg-fixture-tls: ready at ${conn.host}:${conn.port} (db=${conn.db})`);
  return conn;
}

/** Tear down the container and remove the temp dir. */
export async function teardownTlsPg(): Promise<void> {
  if (containerRef) {
    try {
      await containerRef.stop();
    } catch (err) {
      log(`pg-fixture-tls: stop() failed (${String(err)}); continuing`);
    }
    containerRef = null;
  }
  if (workDirRef && existsSync(workDirRef)) {
    try {
      rmSync(workDirRef, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    workDirRef = null;
  }
}

/** True iff `openssl` is on PATH (the cert-generation prerequisite). */
export function isOpensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
