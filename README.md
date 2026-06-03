The Neon CLI is a command-line interface that lets you manage [Neon Serverless Postgres](https://neon.tech/) directly from the terminal. For the complete documentation, see [Neon CLI](https://neon.tech/docs/reference/neon-cli).

## Install the Neon CLI

**npm**

```shell
npm i -g neonctl
```

Requires Node.js 18.0 or higher.

**Howebrew**

```shell
brew install neonctl
```

**Binary (macOS, Linux, Windows)**

Download a binary file [here](https://github.com/neondatabase/neonctl/releases).

### Upgrade

**npm**

```shell
npm update -g neonctl
```

Requires Node.js 18.0 or higher.

**Howebrew**

```shell
brew upgrade neonctl
```

**Binary (macOS, Linux, Windows)**

To upgrade a binary version, download the latest binary file, as described above, and replace your old binary with the new one.

## Connect

Run the following command to authenticate a connection to Neon:

```bash
neonctl auth
```

The `auth` command launches a browser window where you can authorize the Neon CLI to access your Neon account. Running a Neon CLI command without authenticating with [neonctl auth](https://neon.tech/docs/reference/cli-auth) automatically launches the browser authentication process.

Alternatively, you can authenticate a connection with a Neon API key using the `--api-key` option when running a Neon CLI command. For example, an API key is used with the following `neonctl projects list` command:

```bash
neonctl projects list --api-key <neon_api_key>
```

For information about obtaining an Neon API key, see [Authentication](https://api-docs.neon.tech/reference/authentication), in the _Neon API Reference_.

## Connect with psql

Several commands accept a `--psql` flag that opens a psql session against the resolved endpoint:

```bash
neonctl connection-string --psql --project-id <id>
neonctl projects create --psql
neonctl branches create --psql
```

Any arguments after `--` are forwarded to psql, for example:

```bash
neonctl cs --psql --project-id <id> -- -c "SELECT version()"
neonctl cs --psql --project-id <id> -- -f script.sql --csv
```

### Embedded psql fallback

If the system has `psql` installed on `$PATH`, `--psql` continues to spawn the native binary — there is no behavior change for existing users.

If `psql` is not found on `$PATH`, neonctl now falls back to an embedded TypeScript implementation. There is nothing to install or configure; it ships with `neonctl`. This removes the "no psql binary" trap on machines (and CI runners) that don't have PostgreSQL client tools installed.

The embedded psql can also be forced explicitly:

- `--fallback` — opt-in flag on `connection-string`, `projects create`, and `branches create`. Useful for testing or for environments where you want a guaranteed psql experience regardless of what's on `$PATH`. The flag is currently hidden from `--help` while conformance test coverage is built out; it is safe to use today.
- `NEONCTL_PSQL_FALLBACK=1` — environment variable with the same effect as `--fallback`. Convenient for scripts and CI.

The embedded implementation is verified against a conformance suite that
diffs its behavior against real PostgreSQL (14–18) and the upstream psql
regression + TAP tests.

#### What works

**REPL & scripting**

- Interactive REPL with a hand-rolled VT100 line editor (no native bindings); vi and emacs edit modes (`VI_MODE` psql variable)
- Persistent command history (`~/.psql_history`, libreadline format)
- `~/.psqlrc` autoload (including `$PGSYSCONFDIR/psqlrc` and version-suffixed variants)
- Scripted modes: `-c "SQL"`, `-f script.sql`, and stdin; `--single-transaction`, `ON_ERROR_STOP`, `ECHO`, `--echo-all`
- `SINGLELINE` (`-S`), `\timing`, `\watch` (named flags `c=`/`i=`/`m=`, unbounded continuous mode)

**Backslash commands**

- All output formats: aligned, unaligned, wrapped, csv, json, html, asciidoc, latex, latex-longtable, troff-ms (`\a \H \t \x \pset \f \C` …)
- All `\d*` describe commands with full upstream parity (columns, indexes, foreign keys, triggers, view definitions, sequences, RLS, replica identity, partitions, tablespaces, access methods, inheritance, FDW, stats objects, publications, subscriptions, per-column FDW options, TOAST owner)
- `\copy` to/from file, `PROGRAM`, `STDIN`, `STDOUT` (incl. the `\.` EOF marker); `\g` / `\gx` / `\gset` / `\gdesc` / `\gexec` and `\g | program` pipes
- Extended query + pipeline mode (`\bind`, `\bind_named`, `\startpipeline`, `\parse`, `\sendpipeline`)
- `\crosstabview`, `\lo_*` large objects, `\e`/`\edit` (external editor), `\s` (history), `\?`/`\h` help, `\if`/`\elif`/`\else`/`\endif`, `\set`/`\unset`, `\connect`, `\encoding` (live `SET client_encoding`), `\!`, `\cd`, `\prompt` (incl. no-echo `-`), `\password`
- Tab completion (~88 rules incl. live `pg_settings` GUC lookup, deep `ALTER` sub-actions, `JOIN` clauses, window `OVER`)

**Connection & authentication**

- libpq-equivalent lookup precedence: argv flags > URI > `PG*` env vars > `~/.pgpass` > `pg_service.conf` > libpq defaults
- SCRAM-SHA-256 / SCRAM-SHA-256-PLUS with `tls-server-end-point` channel binding (`channel_binding`); MD5 and cleartext; `require_auth`
- Multi-host failover & load balancing: `target_session_attrs` (any / read-write / read-only / primary / standby / prefer-standby), `load_balance_hosts`, DNS fan-out, `hostaddr`
- Unix-domain sockets (host beginning with `/`); TCP keepalives (`keepalives`, `keepalives_idle`)

**TLS**

- `sslmode` disable → verify-full; client certs in **PEM or DER** via `sslcert` / `sslkey` (+ `sslpassword` for encrypted keys, with the libpq group/world-readable-key check)
- Trust config: `sslrootcert` (incl. `=system` with `SSL_CERT_FILE` / `SSL_CERT_DIR`), default client-cert discovery (`~/.postgresql/postgresql.{crt,key}`), `sslcertmode`
- CRL: `sslcrl` and `sslcrldir`; `ssl_min_protocol_version` / `ssl_max_protocol_version`; `sslsni`
- Direct-SSL negotiation (`sslnegotiation=direct`, PostgreSQL 17+, via ALPN)

#### What's not supported

- **GSSAPI / SSPI** (`gssencmode`, Kerberos/SSPI auth, `requirepeer`). GSS transport encryption needs a native Kerberos binding, which the embedded psql deliberately avoids (pure TypeScript, zero native dependencies — the same reason the line editor is hand-rolled). `node-postgres` doesn't support it either, and Neon doesn't use it. `gssencmode=disable` / `prefer` are accepted; `gssencmode=require` is rejected with a clear error. `requirepeer` is parsed but a Unix-socket connection that sets it is refused (Node exposes no peer-credential API — it is not silently ignored).
- **`keepalives_interval` / `keepalives_count`** — Node's socket API exposes only keepalive enable + initial delay, so these are accepted but not applied.

### Known limitations

- The `--fallback` flag is hidden in `--help` until conformance coverage stabilises. The behavior is safe to use today; the hide just signals "not yet flipped to default."
- **TLS cipher is runtime-dependent.** The negotiated TLS 1.3 ciphersuite is chosen by the host runtime's TLS library from an offer byte-identical to libpq's. Under Node (OpenSSL) that is `TLS_AES_256_GCM_SHA384`, matching vanilla psql; under Bun (BoringSSL) it is `TLS_AES_128_GCM_SHA256`. Both are TLS 1.3 AEAD suites with no practical security difference, and neither runtime exposes a client-side knob to steer the selection.

## Configure autocompletion

The Neon CLI supports autocompletion, which you can configure in a few easy steps. See [Neon CLI commands — completion](https://neon.tech/docs/reference/cli-completion) for instructions.

## Commands

| Command                                                                    | Subcommands                                                                                 | Description                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------ |
| [auth](https://neon.com/docs/reference/cli-auth)                           |                                                                                             | Authenticate                   |
| [projects](https://neon.com/docs/reference/cli-projects)                   | `list`, `create`, `update`, `delete`, `get`                                                 | Manage projects                |
| [ip-allow](https://neon.com/docs/reference/cli-ip-allow)                   | `list`, `add`, `remove`, `reset`                                                            | Manage IP Allow                |
| [me](https://neon.com/docs/reference/cli-me)                               |                                                                                             | Show current user              |
| [branches](https://neon.com/docs/reference/cli-branches)                   | `list`, `create`, `rename`, `add-compute`, `set-default`, `set-expiration`, `delete`, `get` | Manage branches                |
| [databases](https://neon.com/docs/reference/cli-databases)                 | `list`, `create`, `delete`                                                                  | Manage databases               |
| [roles](https://neon.com/docs/reference/cli-roles)                         | `list`, `create`, `delete`                                                                  | Manage roles                   |
| [operations](https://neon.com/docs/reference/cli-operations)               | `list`                                                                                      | Manage operations              |
| [connection-string](https://neon.com/docs/reference/cli-connection-string) |                                                                                             | Get connection string          |
| psql                                                                       |                                                                                             | Connect to a database via psql |
| [set-context](https://neon.com/docs/reference/cli-set-context)             |                                                                                             | Set context for session        |
| [completion](https://neon.com/docs/reference/cli-completion)               |                                                                                             | Generate a completion script   |

## Global options

Global options are supported with any Neon CLI command.

| Option                      | Description                                                 | Type    | Default                        |
| :-------------------------- | :---------------------------------------------------------- | :------ | :----------------------------- |
| [-o, --output](#output)     | Set the Neon CLI output format (`json`, `yaml`, or `table`) | string  | table                          |
| [--config-dir](#config-dir) | Path to the Neon CLI configuration directory                | string  | `/home/<user>/.config/neonctl` |
| [--api-key](#api-key)       | Neon API key                                                | string  | ""                             |
| [--analytics](#analytics)   | Manage analytics                                            | boolean | true                           |
| [-v, --version](#version)   | Show the Neon CLI version number                            | boolean | -                              |
| [-h, --help](#help)         | Show the Neon CLI help                                      | boolean | -                              |

- <a id="output"></a>`-o, --output`

  Sets the output format. Supported options are `json`, `yaml`, and `table`. The default is `table`. Table output may be limited. The `json` and `yaml` output formats show all data.

  ```bash
  neonctl me --output json
  ```

- <a id="config-dir"></a>`--config-dir`

  Specifies the path to the `neonctl` configuration directory. To view the default configuration directory containing you `credentials.json` file, run `neonctl --help`. The credentials file is created when you authenticate using the `neonctl auth` command. This option is only necessary if you move your `neonctl` configuration file to a location other than the default.

  ```bash
  neonctl projects list --config-dir /home/dtprice/.config/neonctl
  ```

- <a id="api-key"></a>`--api-key`

  Specifies your Neon API key. You can authenticate using a Neon API key when running a Neon CLI command instead of using `neonctl auth`. For information about obtaining an Neon API key, see [Authentication](https://api-docs.neon.tech/reference/authentication), in the _Neon API Reference_.

  ```bash
  neonctl <command> --api-key <neon_api_key>
  ```

- <a id="analytics"></a>`--analytics`

  Analytics are enabled by default to gather information about the CLI commands and options that are used by our customers. This data collection assists in offering support, and allows for a better understanding of typical usage patterns so that we can improve user experience. Neon does not collect user-defined data, such as project IDs or command payloads. To opt-out of analytics data collection, specify `--no-analytics` or `--analytics false`.

- <a id="version"></a>`-v, --version`

  Shows the Neon CLI version number.

  ```bash
  $ neonctl --version
  1.15.0
  ```

- <a id="help"></a>`-h, --help`

  Shows the `neonctl` command-line help. You can view help for `neonctl`, a `neonctl` command, or a `neonctl` subcommand, as shown in the following examples:

  ```bash
  neonctl --help

  neonctl branches --help

  neonctl branches create --help
  ```

## Contribute

This repo uses [pnpm](https://pnpm.io). The required version is pinned in `.tool-versions` and `package.json`'s `packageManager` field. The simplest way to get the right version is [mise](https://mise.jdx.dev): `mise install` reads `.tool-versions` and installs Node and pnpm. Alternatives: `npm install -g pnpm@9.15.9`, or [Corepack](https://nodejs.org/api/corepack.html) (`corepack enable pnpm`).

To run the CLI locally, execute the build command after making changes:

```shell
pnpm install
pnpm run build
```

To develop continuously:

```shell
pnpm run watch
```

To run commands from the local build, replace the `neonctl` command with `node dist`; for example:

```shell
node dist branches --help
```

### Embedded psql tests

The embedded TypeScript psql implementation has its own conformance test suite that runs the same scripts against the embedded psql and a reference `psql` binary, then diffs the output.

```shell
bun run test:conformance         # run against $PSQL_BINARY (defaults to the system psql)
bun run test:conformance:matrix  # run across PG 14/15/16/17/18 locally (requires Docker)
```
