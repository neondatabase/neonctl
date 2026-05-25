/**
 * Conformance tests for `parseConnectionUri` ported from upstream
 * `src/interfaces/libpq/t/001_uri.pl` (PostgreSQL REL_18_0).
 *
 * The vendored Perl reference lives at:
 *   tests/psql-conformance/vendor/postgres-18.0/src/interfaces/libpq/t/001_uri.pl
 *
 * Each upstream row is a `[uri, expected_stdout, expected_stderr, ...env]`
 * tuple. We translate the libpq verbose-conninfo key/value pairs into our
 * ConnectOptions shape:
 *   user='X'      -> user
 *   password='X'  -> password
 *   dbname='X'    -> database
 *   host='X'      -> host
 *   port='X'      -> port (numeric)
 *   sslmode='X'   -> ssl
 *
 * libpq-specific cases we cannot model (hostaddr=, multi-host, unix sockets,
 * percent-encoding validation, replication, service files) are kept as
 * `it.skip` entries with a comment so the upstream coverage is documented.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { parseConnectionUri } from './index.js';
import type { ConnectOptions } from './types/connection.js';

// Pin USER so empty-userinfo cases are deterministic across machines.
const FIXED_USER = 'tester';

beforeEach(() => {
  process.env.USER = FIXED_USER;
});

type Expected = Partial<ConnectOptions>;
type Case = { name: string; uri: string; expected: Expected };

// ---------------------------------------------------------------------------
// Cases that mirror upstream exactly (translated key=value -> ConnectOptions).
//
// Where upstream omits a key (e.g. no dbname), we don't assert on that key —
// `toMatchObject` already ignores keys not in `expected`. Our parser does
// fill in defaults (e.g. database falls back to user) which is intentional
// and not contradicted by the upstream expected output.
// ---------------------------------------------------------------------------
const cases: Case[] = [
  // user:password@host:port/db — the canonical happy path.
  {
    name: 'postgresql://uri-user:secret@host:12345/db',
    uri: 'postgresql://uri-user:secret@host:12345/db',
    expected: {
      user: 'uri-user',
      password: 'secret',
      database: 'db',
      host: 'host',
      port: 12345,
    },
  },
  {
    name: 'postgresql://uri-user@host:12345/db',
    uri: 'postgresql://uri-user@host:12345/db',
    expected: { user: 'uri-user', database: 'db', host: 'host', port: 12345 },
  },
  {
    name: 'postgresql://uri-user@host/db',
    uri: 'postgresql://uri-user@host/db',
    expected: { user: 'uri-user', database: 'db', host: 'host', port: 5432 },
  },
  {
    name: 'postgresql://host:12345/db',
    uri: 'postgresql://host:12345/db',
    expected: { database: 'db', host: 'host', port: 12345 },
  },
  {
    name: 'postgresql://host/db (first occurrence)',
    uri: 'postgresql://host/db',
    expected: { database: 'db', host: 'host' },
  },
  {
    name: 'postgresql://uri-user@host:12345/',
    uri: 'postgresql://uri-user@host:12345/',
    expected: { user: 'uri-user', host: 'host', port: 12345 },
  },
  {
    name: 'postgresql://uri-user@host/',
    uri: 'postgresql://uri-user@host/',
    expected: { user: 'uri-user', host: 'host' },
  },

  // userinfo-only — libpq treats this as a local socket connection. We don't
  // support sockets, so host falls back to 'localhost'. user is preserved.
  {
    name: 'postgresql://uri-user@',
    uri: 'postgresql://uri-user@',
    expected: { user: 'uri-user', host: 'localhost' },
  },
  {
    name: 'postgresql://host:12345/',
    uri: 'postgresql://host:12345/',
    expected: { host: 'host', port: 12345 },
  },
  {
    name: 'postgresql://host:12345 (no trailing slash)',
    uri: 'postgresql://host:12345',
    expected: { host: 'host', port: 12345 },
  },
  {
    name: 'postgresql://host/db (second occurrence)',
    uri: 'postgresql://host/db',
    expected: { database: 'db', host: 'host' },
  },
  {
    name: 'postgresql://host/',
    uri: 'postgresql://host/',
    expected: { host: 'host' },
  },
  {
    name: 'postgresql://host (no path)',
    uri: 'postgresql://host',
    expected: { host: 'host' },
  },
  {
    name: 'postgresql:// (bare)',
    uri: 'postgresql://',
    expected: { host: 'localhost' },
  },

  // Percent-encoded host — libpq decodes %68 -> 'h'.
  {
    name: 'postgresql://%68ost/ — percent-encoded host',
    uri: 'postgresql://%68ost/',
    expected: { host: 'host' },
  },

  // Query string parameters override or supply connection params.
  {
    name: 'postgresql://host/db?user=uri-user',
    uri: 'postgresql://host/db?user=uri-user',
    expected: { user: 'uri-user', database: 'db', host: 'host' },
  },
  {
    name: 'postgresql://host/db?user=uri-user&port=12345',
    uri: 'postgresql://host/db?user=uri-user&port=12345',
    expected: { user: 'uri-user', database: 'db', host: 'host', port: 12345 },
  },
  {
    name: 'postgresql://host/db?u%73er=someotheruser&port=12345 — percent-encoded query key',
    uri: 'postgresql://host/db?u%73er=someotheruser&port=12345',
    expected: {
      user: 'someotheruser',
      database: 'db',
      host: 'host',
      port: 12345,
    },
  },
  {
    name: 'postgresql://host:12345?user=uri-user',
    uri: 'postgresql://host:12345?user=uri-user',
    expected: { user: 'uri-user', host: 'host', port: 12345 },
  },
  {
    name: 'postgresql://host?user=uri-user',
    uri: 'postgresql://host?user=uri-user',
    expected: { user: 'uri-user', host: 'host' },
  },
  {
    name: 'postgresql://host? — leading/trailing query whitespace',
    uri: 'postgresql://host?  user = uri-user & port  = 12345 ',
    expected: { user: 'uri-user', host: 'host', port: 12345 },
  },
  {
    name: 'postgresql://host? — empty query',
    uri: 'postgresql://host?',
    expected: { host: 'host' },
  },

  // IPv6 host — libpq strips the brackets when reporting.
  {
    name: 'postgresql://[::1]:12345/db',
    uri: 'postgresql://[::1]:12345/db',
    expected: { database: 'db', host: '::1', port: 12345 },
  },
  {
    name: 'postgresql://[::1]/db',
    uri: 'postgresql://[::1]/db',
    expected: { database: 'db', host: '::1' },
  },
  {
    name: 'postgresql://[2001:db8::1234]/',
    uri: 'postgresql://[2001:db8::1234]/',
    expected: { host: '2001:db8::1234' },
  },
  {
    name: 'postgresql://[200z:db8::1234]/ — libpq accepts non-canonical IPv6',
    uri: 'postgresql://[200z:db8::1234]/',
    expected: { host: '200z:db8::1234' },
  },
  {
    name: 'postgresql://[::1] (no path, no port)',
    uri: 'postgresql://[::1]',
    expected: { host: '::1' },
  },

  // `postgres://` scheme — alternate form, must behave identically.
  {
    name: 'postgres:// — alternate scheme',
    uri: 'postgres://',
    expected: { host: 'localhost' },
  },
  {
    name: 'postgres:/// — alternate scheme with empty path',
    uri: 'postgres:///',
    expected: { host: 'localhost' },
  },
  {
    name: 'postgres:///db',
    uri: 'postgres:///db',
    expected: { database: 'db', host: 'localhost' },
  },
  {
    name: 'postgres://uri-user@/db — userinfo with empty host (libpq local socket)',
    uri: 'postgres://uri-user@/db',
    expected: { user: 'uri-user', database: 'db', host: 'localhost' },
  },

  // Edge authority shapes that libpq accepts.
  {
    name: 'postgres://@host — empty userinfo before @',
    uri: 'postgres://@host',
    expected: { host: 'host', user: FIXED_USER },
  },
  {
    name: 'postgres://host:/ — empty port after colon',
    uri: 'postgres://host:/',
    expected: { host: 'host', port: 5432 },
  },
  {
    name: 'postgres://:12345/ — port without host',
    uri: 'postgres://:12345/',
    expected: { host: 'localhost', port: 12345 },
  },

  // sslmode in the query string.
  {
    name: 'postgresql://host?sslmode=disable',
    uri: 'postgresql://host?sslmode=disable',
    expected: { host: 'host', ssl: 'disable' },
  },
  {
    name: 'postgresql://host?sslmode=prefer',
    uri: 'postgresql://host?sslmode=prefer',
    expected: { host: 'host', ssl: 'prefer' },
  },
  {
    name: 'postgresql://host?sslmode=verify-full',
    uri: 'postgresql://host?sslmode=verify-full',
    expected: { host: 'host', ssl: 'verify-full' },
  },

  // Cases not in upstream but exercising our own parser surface.
  {
    name: 'percent-encoded user/password with @ and :',
    uri: 'postgresql://user%40domain:p%40ss@host/db',
    expected: {
      user: 'user@domain',
      password: 'p@ss',
      host: 'host',
      database: 'db',
    },
  },
  {
    name: 'channel_binding=require',
    uri: 'postgresql://host?channel_binding=require',
    expected: { host: 'host', channelBinding: 'require' },
  },
  {
    name: 'application_name=foo',
    uri: 'postgresql://host?application_name=foo',
    expected: { host: 'host', applicationName: 'foo' },
  },
  {
    name: 'options=-c synchronous_commit=off (percent-encoded)',
    uri: 'postgresql://host?options=-c%20synchronous_commit%3Doff',
    expected: { host: 'host', options: '-c synchronous_commit=off' },
  },
];

describe('parseConnectionUri — upstream 001_uri.pl conformance', () => {
  it.each(cases)('$name', ({ uri, expected }) => {
    const got = parseConnectionUri(uri);
    expect(got).toMatchObject(expected);
  });
});

// ---------------------------------------------------------------------------
// Error / malformed-input cases. Upstream uses these to assert specific
// stderr messages; we only assert that the function rejects them (or, where
// noted, accepts them deliberately).
// ---------------------------------------------------------------------------
describe('parseConnectionUri — error / malformed inputs', () => {
  it('throws on missing matching IPv6 bracket', () => {
    expect(() => parseConnectionUri('postgres://[::1')).toThrow(/IPv6/);
  });

  it('throws on garbage after IPv6 host (no : or /)', () => {
    expect(() => parseConnectionUri('postgres://[::1]z')).toThrow(/IPv6/);
  });

  it('rejects unknown scheme', () => {
    expect(() => parseConnectionUri('http://host/db')).toThrow(
      /unsupported scheme/,
    );
  });

  it('rejects out-of-range port', () => {
    expect(() => parseConnectionUri('postgresql://host:99999')).toThrow(
      /invalid port/,
    );
  });

  it('rejects non-numeric port', () => {
    expect(() => parseConnectionUri('postgresql://host:abc')).toThrow(
      /invalid port/,
    );
  });
});

// ---------------------------------------------------------------------------
// Upstream cases we deliberately do NOT cover. Kept here so the gap is
// documented next to the conformance corpus rather than buried in a README.
// ---------------------------------------------------------------------------
describe('parseConnectionUri — upstream cases not supported', () => {
  // libpq's `hostaddr` skips DNS resolution. neonctl-psql connects via the
  // standard Node TLS stack, which always resolves. We don't surface this
  // libpq-specific knob.
  it.todo('postgresql://?hostaddr=127.0.0.1 — hostaddr not modelled');
  it.todo('postgresql://example.com?hostaddr=63.1.2.4 — hostaddr not modelled');

  // libpq permits unix-domain sockets via percent-encoded paths in the host
  // slot or via `host=/path/to/socket` overrides. We're a TCP-only client.
  it.todo('postgresql://?host=/path/to/socket/dir — unix socket');
  it.todo('postgres://otheruser@?host=/no/such/directory — unix socket');
  it.todo('postgres://otheruser@/?host=/no/such/directory — unix socket');
  it.todo(
    'postgres://otheruser@:12345?host=/no/such/socket/path — unix socket',
  );
  it.todo('postgres://otheruser@:12345/db?host=/path/to/socket — unix socket');
  it.todo('postgres://:12345/db?host=/path/to/socket — unix socket');
  it.todo('postgres://:12345?host=/path/to/socket — unix socket');
  it.todo(
    'postgres://%2Fvar%2Flib%2Fpostgresql/dbname — unix socket in authority',
  );

  // libpq surfaces specific stderr for malformed/invalid query keys. Our
  // parser is lenient (decodes what it can, drops empty keys). We don't aim
  // for byte-identical error messages.
  it.todo(
    'postgresql://host/db?u%7aer=someotheruser&port=12345 — rejects "uzer" key',
  );
  it.todo('postgresql://host?uzer= — rejects unknown query key');
  it.todo(
    'postgresql://host?  user user  = uri  & port = 12345 12 — internal whitespace',
  );
  it.todo(
    'postgresql://host?  user  = uri-user  & port = 12345 12 — internal whitespace in value',
  );
  it.todo('postgresql://host?zzz — missing "=" in query');
  it.todo('postgresql://host?value1&value2 — multiple bare query keys');
  it.todo('postgresql://host?key=key=value — extra "=" in value');
  it.todo('postgre:// — unknown scheme libpq-style error');

  // libpq validates percent-encoding strictly: %XX must be two hex digits,
  // %00 is forbidden. We rely on decodeURIComponent's behaviour and don't
  // surface bespoke errors for these.
  it.todo('postgres://host?dbname=%XXfoo — invalid percent-encoded token');
  it.todo('postgresql://a%00b — forbidden %00');
  it.todo('postgresql://%zz — invalid percent-encoded token');
  it.todo('postgresql://%1 — incomplete percent-encoded token');
  it.todo('postgresql://% — bare %');
  it.todo('postgres://[] — empty IPv6 host');
});
