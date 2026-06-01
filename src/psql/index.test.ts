/**
 * Conformance tests for `parseConnectionUri` ported from upstream
 * `src/interfaces/libpq/t/001_uri.pl` (PostgreSQL REL_18_0).
 *
 * Upstream Perl reference:
 *   https://github.com/postgres/postgres/blob/REL_18_0/src/interfaces/libpq/t/001_uri.pl
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

import {
  looksLikeConnectionString,
  parseConninfo,
  parseConnectionUri,
} from './index.js';
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
    name: 'application_name defaults to "psql" (matches upstream)',
    uri: 'postgresql://host/db',
    expected: { host: 'host', database: 'db', applicationName: 'psql' },
  },
  {
    name: 'options=-c synchronous_commit=off (percent-encoded)',
    uri: 'postgresql://host?options=-c%20synchronous_commit%3Doff',
    expected: { host: 'host', options: '-c synchronous_commit=off' },
  },

  // Replication mode (walsender). The URI parser threads `?replication=…`
  // through `ConnectOptions.replication`, which the startup-message builder
  // then sends as a literal parameter. Values are normalised to libpq's
  // surface: 'database' for logical, 'true' for the physical-replication
  // truthy-set ('on' / 'yes' / '1' / 'true').
  {
    name: '?replication=database (logical walsender)',
    uri: 'postgresql://u@h/db?replication=database',
    expected: {
      host: 'h',
      user: 'u',
      database: 'db',
      replication: 'database',
    },
  },
  {
    name: '?replication=true (physical walsender)',
    uri: 'postgresql://u@h/db?replication=true',
    expected: { host: 'h', database: 'db', replication: 'true' },
  },
  {
    name: 'replication=on normalises to true',
    uri: 'postgresql://u@h/db?replication=on',
    expected: { host: 'h', database: 'db', replication: 'true' },
  },
  {
    name: 'replication=1 normalises to true',
    uri: 'postgresql://u@h/db?replication=1',
    expected: { host: 'h', database: 'db', replication: 'true' },
  },
];

describe('parseConnectionUri — upstream 001_uri.pl conformance', () => {
  it.each(cases)('$name', ({ uri, expected }) => {
    const got = parseConnectionUri(uri);
    expect(got).toMatchObject(expected);
  });
});

// ---------------------------------------------------------------------------
// Multi-host authority + ?host=/?port= list. libpq 10+ accepts comma-
// separated host[:port] tuples in the authority and comma-separated host=/
// port= lists in the query string. Single-host callers continue to see
// `opts.host`/`opts.port` only; multi-host populates `opts.hosts`.
// ---------------------------------------------------------------------------
describe('parseConnectionUri — multi-host', () => {
  it('parses comma-separated authority tuples (mixed explicit / default ports)', () => {
    const got = parseConnectionUri('postgresql://h1:5432,h2,h3:5434/db');
    // Scalar host/port retain the FIRST entry so single-host callers see no
    // surface change.
    expect(got.host).toBe('h1');
    expect(got.port).toBe(5432);
    expect(got.hosts).toEqual([
      { host: 'h1', port: 5432 },
      { host: 'h2', port: 5432 },
      { host: 'h3', port: 5434 },
    ]);
  });

  it('parses ?host=h1,h2,h3 with ?port=5432,5433,5434', () => {
    const got = parseConnectionUri(
      'postgresql:///db?host=h1,h2,h3&port=5432,5433,5434',
    );
    expect(got.host).toBe('h1');
    expect(got.port).toBe(5432);
    expect(got.hosts).toEqual([
      { host: 'h1', port: 5432 },
      { host: 'h2', port: 5433 },
      { host: 'h3', port: 5434 },
    ]);
  });

  it('broadcasts a single ?port= to every host in ?host=h1,h2', () => {
    const got = parseConnectionUri('postgresql:///db?host=h1,h2&port=6543');
    expect(got.hosts).toEqual([
      { host: 'h1', port: 6543 },
      { host: 'h2', port: 6543 },
    ]);
  });

  it('rejects mismatched host/port list lengths', () => {
    expect(() =>
      parseConnectionUri('postgresql:///db?host=h1,h2,h3&port=5432,5433'),
    ).toThrow(/could not match 2 port numbers to 3 hosts/);
  });

  it('does not set opts.hosts for a single host (single-host call site stays unchanged)', () => {
    const got = parseConnectionUri('postgresql://h1:5432/db');
    expect(got.host).toBe('h1');
    expect(got.port).toBe(5432);
    expect(got.hosts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// target_session_attrs + load_balance_hosts URI params.
// ---------------------------------------------------------------------------
describe('parseConnectionUri — target_session_attrs / load_balance_hosts', () => {
  it('threads ?target_session_attrs=read-write into ConnectOptions', () => {
    const got = parseConnectionUri(
      'postgresql://h1,h2/db?target_session_attrs=read-write',
    );
    expect(got.targetSessionAttrs).toBe('read-write');
  });

  it('threads ?load_balance_hosts=random into ConnectOptions', () => {
    const got = parseConnectionUri(
      'postgresql://h1,h2/db?load_balance_hosts=random',
    );
    expect(got.loadBalanceHosts).toBe('random');
  });

  it('rejects unrecognised target_session_attrs value', () => {
    expect(() =>
      parseConnectionUri('postgresql://h/db?target_session_attrs=bogus'),
    ).toThrow(/invalid value for "target_session_attrs"/);
  });

  it('rejects unrecognised load_balance_hosts value', () => {
    expect(() =>
      parseConnectionUri('postgresql://h/db?load_balance_hosts=roundrobin'),
    ).toThrow(/invalid value for "load_balance_hosts"/);
  });
});

// ---------------------------------------------------------------------------
// Error / malformed-input cases. Upstream uses these to assert specific
// stderr messages; we only assert that the function rejects them (or, where
// noted, accepts them deliberately).
// ---------------------------------------------------------------------------
describe('parseConnectionUri — error / malformed inputs', () => {
  it('throws on unrecognised replication value', () => {
    expect(() =>
      parseConnectionUri('postgresql://u@h/db?replication=bogus'),
    ).toThrow(/invalid value.*replication/i);
  });

  it('does not set replication when omitted', () => {
    const got = parseConnectionUri('postgresql://u@h/db');
    expect(got.replication).toBeUndefined();
  });

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
// libpq strict-validation cases. These mirror upstream 001_uri.pl error rows
// that we now reject. Messages aren't byte-identical with libpq — we only
// assert that the parser throws (and that the message matches a stable
// fragment, so regressions surface clearly).
// ---------------------------------------------------------------------------
describe('parseConnectionUri — libpq strict validation', () => {
  // Unknown query keys (libpq's "invalid URI query parameter" rejection).
  // Includes a percent-encoded form (u%7aer -> "uzer") to confirm we validate
  // the *decoded* key.
  it('rejects unknown query key (percent-encoded "uzer")', () => {
    expect(() =>
      parseConnectionUri(
        'postgresql://host/db?u%7aer=someotheruser&port=12345',
      ),
    ).toThrow(/invalid URI query parameter: "uzer"/);
  });

  it('rejects unknown query key "uzer"', () => {
    expect(() => parseConnectionUri('postgresql://host?uzer=')).toThrow(
      /invalid URI query parameter: "uzer"/,
    );
  });

  // Bare keys (no `=`) — `?zzz` and `?value1&value2` are upstream rows.
  it('rejects bare query key (no "=")', () => {
    expect(() => parseConnectionUri('postgresql://host?zzz')).toThrow(
      /missing "="/,
    );
  });

  it('rejects multiple bare query keys', () => {
    expect(() => parseConnectionUri('postgresql://host?value1&value2')).toThrow(
      /missing "="/,
    );
  });

  // Extra `=` in a value: libpq treats the second `=` as a syntax error;
  // we follow suit because the value would otherwise be ambiguous with the
  // percent-encoded form `%3D`.
  it('rejects extra "=" in query value', () => {
    expect(() => parseConnectionUri('postgresql://host?key=key=value')).toThrow(
      /extra "="/,
    );
  });

  // Unknown scheme. libpq emits a specific "missing/unknown schema" error;
  // we share the umbrella "unsupported scheme" with non-postgres URIs.
  it('rejects "postgre://" scheme', () => {
    expect(() => parseConnectionUri('postgre://')).toThrow(
      /unsupported scheme/,
    );
  });

  // Stretch: internal whitespace inside a query key. We already trim leading
  // and trailing whitespace around `=` (see the passing
  // "leading/trailing query whitespace" case), so `user user` survives the
  // trim and is rejected by the strict-key check as a side effect.
  it('rejects internal whitespace in query key (becomes unknown key)', () => {
    expect(() =>
      parseConnectionUri(
        'postgresql://host?  user user  = uri  & port = 12345 12',
      ),
    ).toThrow(/invalid URI query parameter: "user user"/);
  });

  // Strict percent-encoding. decodeURIComponent throws on malformed escapes;
  // we surface a clear Error. %00 is accepted by decodeURIComponent as \0 —
  // we additionally guard against NUL.
  it('rejects invalid percent-encoded token in query value (%XX)', () => {
    expect(() => parseConnectionUri('postgres://host?dbname=%XXfoo')).toThrow(
      /invalid percent-encoded token/,
    );
  });

  it('rejects forbidden NUL byte (%00)', () => {
    expect(() => parseConnectionUri('postgresql://a%00b')).toThrow(
      /forbidden NUL byte/,
    );
  });

  it('rejects invalid percent-encoded token (%zz)', () => {
    expect(() => parseConnectionUri('postgresql://%zz')).toThrow(
      /invalid percent-encoded token/,
    );
  });

  it('rejects incomplete percent-encoded token (%1)', () => {
    expect(() => parseConnectionUri('postgresql://%1')).toThrow(
      /invalid percent-encoded token/,
    );
  });

  it('rejects bare percent sign (%)', () => {
    expect(() => parseConnectionUri('postgresql://%')).toThrow(
      /invalid percent-encoded token/,
    );
  });

  it('rejects empty IPv6 host', () => {
    expect(() => parseConnectionUri('postgres://[]')).toThrow(
      /IPv6 host address may not be empty/,
    );
  });
});

// ---------------------------------------------------------------------------
// Unix-domain socket URI conformance. libpq permits the socket directory to
// appear either as the `host=` query override (libpq's documented form) or
// percent-encoded in the authority slot (`postgresql://%2Fvar%2Flib%2Fpg/`).
// We surface the directory in `ConnectOptions.host` and let the wire layer
// turn it into `<dir>/.s.PGSQL.<port>` at connect time.
// ---------------------------------------------------------------------------
describe('parseConnectionUri — unix-domain socket conformance', () => {
  it('postgresql://?host=/path/to/socket/dir', () => {
    const got = parseConnectionUri('postgresql://?host=/path/to/socket/dir');
    expect(got).toMatchObject({ host: '/path/to/socket/dir', port: 5432 });
  });

  it('postgres://otheruser@?host=/no/such/directory', () => {
    const got = parseConnectionUri(
      'postgres://otheruser@?host=/no/such/directory',
    );
    expect(got).toMatchObject({
      user: 'otheruser',
      host: '/no/such/directory',
    });
  });

  it('postgres://otheruser@/?host=/no/such/directory', () => {
    const got = parseConnectionUri(
      'postgres://otheruser@/?host=/no/such/directory',
    );
    expect(got).toMatchObject({
      user: 'otheruser',
      host: '/no/such/directory',
    });
  });

  it('postgres://otheruser@:12345?host=/no/such/socket/path', () => {
    const got = parseConnectionUri(
      'postgres://otheruser@:12345?host=/no/such/socket/path',
    );
    expect(got).toMatchObject({
      user: 'otheruser',
      host: '/no/such/socket/path',
      port: 12345,
    });
  });

  it('postgres://otheruser@:12345/db?host=/path/to/socket', () => {
    const got = parseConnectionUri(
      'postgres://otheruser@:12345/db?host=/path/to/socket',
    );
    expect(got).toMatchObject({
      user: 'otheruser',
      database: 'db',
      host: '/path/to/socket',
      port: 12345,
    });
  });

  it('postgres://:12345/db?host=/path/to/socket', () => {
    const got = parseConnectionUri('postgres://:12345/db?host=/path/to/socket');
    expect(got).toMatchObject({
      database: 'db',
      host: '/path/to/socket',
      port: 12345,
    });
  });

  it('postgres://:12345?host=/path/to/socket', () => {
    const got = parseConnectionUri('postgres://:12345?host=/path/to/socket');
    expect(got).toMatchObject({
      host: '/path/to/socket',
      port: 12345,
    });
  });

  it('postgres://%2Fvar%2Flib%2Fpostgresql/dbname (percent-encoded authority)', () => {
    const got = parseConnectionUri(
      'postgres://%2Fvar%2Flib%2Fpostgresql/dbname',
    );
    expect(got).toMatchObject({
      host: '/var/lib/postgresql',
      database: 'dbname',
    });
  });

  // The query parser already percent-decodes values, so a literal `%2Fpath`
  // in `?host=` should land identically to the unencoded form above.
  it('postgresql://?host=%2Fvar%2Frun%2Fpostgresql (percent-encoded query)', () => {
    const got = parseConnectionUri(
      'postgresql://?host=%2Fvar%2Frun%2Fpostgresql',
    );
    expect(got).toMatchObject({ host: '/var/run/postgresql' });
  });
});

// ---------------------------------------------------------------------------
// libpq PEM file paths threaded through the URI query string.
// ---------------------------------------------------------------------------
describe('parseConnectionUri — TLS PEM file paths', () => {
  it('threads sslcert / sslkey / sslrootcert / sslcrl into ConnectOptions', () => {
    const got = parseConnectionUri(
      'postgresql://u@h/db?sslcert=/etc/pg/client.crt' +
        '&sslkey=/etc/pg/client.key' +
        '&sslrootcert=/etc/pg/ca.pem' +
        '&sslcrl=/etc/pg/crl.pem',
    );
    expect(got).toMatchObject({
      sslcert: '/etc/pg/client.crt',
      sslkey: '/etc/pg/client.key',
      sslrootcert: '/etc/pg/ca.pem',
      sslcrl: '/etc/pg/crl.pem',
    });
  });

  it('omits sslcert when the query parameter is empty', () => {
    const got = parseConnectionUri('postgresql://u@h/db?sslcert=');
    expect(got).not.toHaveProperty('sslcert');
  });

  it('accepts percent-encoded paths (sslrootcert=%2Fetc%2Fpg%2Fca.pem)', () => {
    const got = parseConnectionUri(
      'postgresql://u@h/db?sslrootcert=%2Fetc%2Fpg%2Fca.pem',
    );
    expect(got).toMatchObject({ sslrootcert: '/etc/pg/ca.pem' });
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

  // Internal whitespace inside a query value: handled by our port validator
  // (the trimmed value is "12345 12" which fails `invalid port`), but the
  // libpq stderr targets the whitespace itself. We don't attempt to match
  // that more specific error, so it stays a todo.
  it.todo(
    'postgresql://host?  user  = uri-user  & port = 12345 12 — internal whitespace in value',
  );
});

// ---------------------------------------------------------------------------
// Conninfo string parser (libpq-style `key=value` pairs, whitespace separated).
// Drives the `-d "dbname=… replication=…"` shape used by upstream's
// walsender test in `001_basic.pl`.
// ---------------------------------------------------------------------------
describe('parseConninfo', () => {
  it('parses dbname + replication=database', () => {
    expect(parseConninfo('dbname=postgres replication=database')).toEqual({
      database: 'postgres',
      replication: 'database',
    });
  });

  it('handles single-quoted values with embedded whitespace', () => {
    expect(parseConninfo("user='alice bob' dbname=db1")).toEqual({
      user: 'alice bob',
      database: 'db1',
    });
  });

  it('normalises replication=on to true', () => {
    expect(parseConninfo('replication=on')).toEqual({ replication: 'true' });
  });

  it('rejects unknown conninfo keys', () => {
    expect(() => parseConninfo('replicate=database')).toThrow(
      /invalid conninfo key/,
    );
  });

  it('rejects malformed input (missing =)', () => {
    expect(() => parseConninfo('dbname')).toThrow(/missing "="/);
  });

  it('rejects unterminated quoted value', () => {
    expect(() => parseConninfo("user='alice")).toThrow(/unterminated/);
  });

  // Multi-host conninfo: `host=h1,h2,h3` and `port=p1,p2,p3` (or single
  // broadcast port).
  it('parses host=h1,h2,h3 with broadcast port', () => {
    const got = parseConninfo('host=h1,h2,h3 port=5432');
    expect(got.host).toBe('h1');
    expect(got.port).toBe(5432);
    expect(got.hosts).toEqual([
      { host: 'h1', port: 5432 },
      { host: 'h2', port: 5432 },
      { host: 'h3', port: 5432 },
    ]);
  });

  it('parses host=h1,h2 with paired port=5432,5433', () => {
    const got = parseConninfo('host=h1,h2 port=5432,5433');
    expect(got.hosts).toEqual([
      { host: 'h1', port: 5432 },
      { host: 'h2', port: 5433 },
    ]);
  });

  it('rejects mismatched host/port list lengths', () => {
    expect(() => parseConninfo('host=h1,h2,h3 port=5432,5433')).toThrow(
      /could not match 2 port numbers to 3 hosts/,
    );
  });

  it('threads target_session_attrs into ConnectOptions', () => {
    expect(parseConninfo('target_session_attrs=read-write')).toEqual({
      targetSessionAttrs: 'read-write',
    });
  });

  it('threads load_balance_hosts into ConnectOptions', () => {
    expect(parseConninfo('load_balance_hosts=random')).toEqual({
      loadBalanceHosts: 'random',
    });
  });
});

describe('looksLikeConnectionString', () => {
  it('detects URI prefixes', () => {
    expect(looksLikeConnectionString('postgresql://host/db')).toBe(true);
    expect(looksLikeConnectionString('postgres://host/db')).toBe(true);
  });

  it('detects key=value conninfo shape', () => {
    expect(looksLikeConnectionString('dbname=postgres')).toBe(true);
    expect(looksLikeConnectionString('host=h port=5432 dbname=d')).toBe(true);
  });

  it('treats bare database names as not-a-connection-string', () => {
    expect(looksLikeConnectionString('mydb')).toBe(false);
    expect(looksLikeConnectionString('db_with_underscore')).toBe(false);
  });

  it('treats a database name containing = (after space) as bare', () => {
    // Heuristic: `=` must precede whitespace to count as conninfo.
    expect(looksLikeConnectionString('weird name = value')).toBe(false);
  });
});
