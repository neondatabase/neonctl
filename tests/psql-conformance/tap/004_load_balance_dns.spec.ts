// Port of upstream PostgreSQL's
// `src/interfaces/libpq/t/004_load_balance_dns.pl`.
//
// Upstream reference:
//   https://github.com/postgres/postgres/blob/REL_18_0/src/interfaces/libpq/t/004_load_balance_dns.pl
//
// SCOPE — why this spec is documented-skip
// ---------------------------------------------------------------------------
// The upstream test asserts that libpq, given a SINGLE hostname whose
// DNS lookup returns three different A records, will iterate those
// three IPs (sequentially with `load_balance_hosts=disable`, randomly
// with `load_balance_hosts=random`). Concretely:
//
//   host=pg-loadbalancetest load_balance_hosts=random
//   ^^^^^^^^^^^^^^^^^^^^^^^^ one hostname, three IPs in /etc/hosts
//
// Three preconditions are stacked for the upstream test:
//
//   (1) /etc/hosts on the TEST RUNNER's host maps
//       `pg-loadbalancetest` to 127.0.0.1, 127.0.0.2, 127.0.0.3.
//   (2) Three postgres clusters listen on those three IPs (port 5432)
//       and are reachable from the test runner.
//   (3) The CLIENT's connect path performs `getaddrinfo("pg-...")`
//       (returning all three IPs) and then iterates the result list.
//
// Upstream itself skips this test by default — it sits behind the
// `PG_TEST_EXTRA=load_balance` opt-in AND requires admin/root to edit
// `/etc/hosts` AND only runs on Linux / Windows (the only OSes that
// reliably let user-space bind 127.0.0.2 / 127.0.0.3 without extra
// `ifconfig alias` plumbing).
//
// Our additional gap: the TS wire layer at
// `src/psql/wire/connection.ts` only iterates the EXPLICIT
// comma-separated host list in `opts.hosts` (parsed from the URI or
// kw=val string). It does NOT call `dns.lookup` to fan a single
// hostname into multiple addresses; `net.connect({ host, port })` is
// invoked with the hostname as-is and Node picks ONE address (the
// default `lookup` returns the first family-matching result; with
// `autoSelectFamily` enabled, Happy Eyeballs only tries A+AAAA pairs,
// not multiple A records). Until that fan-out is implemented, the
// upstream test's premise cannot hold against our client.
//
// What ships in this WP
// ---------------------------------------------------------------------------
// 1. This file — a vitest spec whose gate is closed by default and
//    whose body lists each upstream assertion as `it.skip(reason)` so
//    the conformance rollup tells the reader what is owed.
//
// 2. A custom docker image scaffold at
//    `tests/psql-conformance/fixtures/loadbalance-dns/` (Dockerfile +
//    entrypoint.sh) that, when the wire layer learns DNS fan-out,
//    will be the live fixture. The image:
//      * runs three independent postgres clusters bound to 127.0.0.1
//        / .2 / .3 on port 5432, and
//      * writes the pg-loadbalancetest hosts-file entries at container
//        startup (Docker rewrites /etc/hosts on boot so build-time
//        edits would be lost).
//
// Flipping this spec to live mode (future work)
// ---------------------------------------------------------------------------
// The cheapest path is to run vitest INSIDE the custom image so
// /etc/hosts inside the container is what `dns.lookup` resolves
// against. Required impl changes BEFORE flipping:
//
//   a) Wire layer: when `opts.host` resolves to multiple A records via
//      `dns.lookup(host, { all: true })`, fan out to N candidates and
//      iterate them under the same `loadBalanceHosts` rule that
//      already exists for the explicit `opts.hosts` array. Mirror
//      libpq's `connectOptions2` step that calls `pg_getaddrinfo_all`
//      and walks `addr_cur` in order.
//
//   b) Spec: drop the `false` in the SHOULD_RUN expression below, set
//      `PGCONFORMANCE_PG_HOST=pg-loadbalancetest`, and replace each
//      `it.skip(...)` with the live assertion sketched in its body.
//
// Why a placeholder spec (not just an open TODO in a ticket): the
// existing TAP-port specs maintain a 1:1 mapping with the upstream
// `t/*.pl` filenames (`001_basic`, `001_ssltests`, `005_negotiate_*`,
// `010_tab_completion`, `020_cancel`, `030_pager`). Leaving the `004`
// slot empty makes the inventory look complete when it isn't. A
// documented-skip slot is the in-repo TODO.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SHOULD_RUN_INTEGRATION } from './_helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

// Path to the docker fixture scaffold. We require the file to exist
// for the "ready to flip" gate below — if a future PR moves / renames
// it, this surface noise reminds the author to update both sides.
const FIXTURE_DIR = join(
  REPO_ROOT,
  'tests',
  'psql-conformance',
  'fixtures',
  'loadbalance-dns',
);
const FIXTURE_PRESENT =
  existsSync(join(FIXTURE_DIR, 'Dockerfile')) &&
  existsSync(join(FIXTURE_DIR, 'entrypoint.sh'));

// Opt-in flag for the (future) live mode. We keep parity with upstream's
// PG_TEST_EXTRA=load_balance gate so the same env signal toggles both
// the perl-side test and ours. Setting this WITHOUT the wire-layer fan-
// out is a no-op (the body is still skipped via WIRE_DNS_FANOUT_DONE).
const LOAD_BALANCE_OPT_IN = /(^|\W)load_balance(\W|$)/.test(
  process.env.PG_TEST_EXTRA ?? '',
);

// Flipped to `true` once the wire layer gains `dns.lookup(host, {all:
// true})` fan-out. Kept as a code-level constant rather than an env
// var so the gate documents what is actually being waited on, not a
// runtime flag. Landed: see `expandHostsViaDns` in
// `src/psql/wire/connection.ts` and the corresponding unit tests in
// `src/psql/wire/connection.test.ts` (`hostname with multiple A records
// fans out`, `IP literals bypass DNS lookup`, `unresolvable hostname is
// dropped from the candidate set`). The remaining gate that keeps THIS
// integration spec skipped on macOS/Windows is the loopback-bind
// requirement (Linux-only) plus the `PG_TEST_EXTRA=load_balance` opt-in.
const WIRE_DNS_FANOUT_DONE = true;

const SHOULD_RUN =
  SHOULD_RUN_INTEGRATION &&
  LOAD_BALANCE_OPT_IN &&
  WIRE_DNS_FANOUT_DONE &&
  // The fixture build only works on Linux (kernel allows binding to
  // 127.0.0.2 / 127.0.0.3 without alias setup). macOS / Windows users
  // would need the loopback-alias dance which is out of scope.
  process.platform === 'linux';

// ---------------------------------------------------------------------------
// Gate suite: explains the closed gate to whoever reads the test
// output. Each closed precondition surfaces as a single visible skip.
// ---------------------------------------------------------------------------

describe('tap/004_load_balance_dns (gate)', () => {
  if (!SHOULD_RUN_INTEGRATION) {
    it.skip('skipped: RUN_INTEGRATION != 1 or dist/psql missing', () => {
      /* unreachable */
    });
  } else if (!FIXTURE_PRESENT) {
    it.skip(
      'skipped: docker fixture missing at fixtures/loadbalance-dns/' +
        ' (Dockerfile + entrypoint.sh)',
      () => {
        /* unreachable */
      },
    );
  } else if (!LOAD_BALANCE_OPT_IN) {
    it.skip(
      'skipped: PG_TEST_EXTRA does not include "load_balance"' +
        ' (matches upstream skip_all)',
      () => {
        /* unreachable */
      },
    );
  } else if (!WIRE_DNS_FANOUT_DONE) {
    it.skip(
      'skipped: wire layer does not fan a single hostname into its DNS' +
        ' addresses (see spec header for the impl change required)',
      () => {
        /* unreachable */
      },
    );
  } else if (process.platform !== 'linux') {
    it.skip(
      'skipped: load_balance fixture requires Linux (loopback 127.0.0.2 /' +
        ' 127.0.0.3 bind without alias setup)',
      () => {
        /* unreachable */
      },
    );
  } else {
    it('gates open: RUN_INTEGRATION=1, fixture present, PG_TEST_EXTRA=load_balance, wire fan-out done, linux', () => {
      expect(true).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Upstream assertion inventory — each `it.skip` mirrors one of the
// upstream `connect_ok` / `ok(...)` calls so future engineers can see
// the contract at a glance and convert them into live `it()`s without
// re-reading the perl source.
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)('tap/004_load_balance_dns', () => {
  // When SHOULD_RUN is true the body would:
  //
  //   * Boot the loadbalance-dns container (image built from
  //     fixtures/loadbalance-dns/Dockerfile).
  //   * Drive the spec from INSIDE that container (so the hostname
  //     `pg-loadbalancetest` resolves through the container's
  //     /etc/hosts), or with --network=host on Linux so the host's
  //     /etc/hosts is honoured. The choice is left to whoever flips
  //     the gate.
  //   * Use `PgConnection.connect` from `dist/psql/wire/connection.js`
  //     against `host=pg-loadbalancetest port=5432`.
  //
  // The body below is unreachable while WIRE_DNS_FANOUT_DONE === false.
  it.todo('runs upstream connect_ok cases (see gate-suite skip reason)');
});

// ---------------------------------------------------------------------------
// Skipped upstream assertions catalogue. Listed individually so the
// conformance rollup counts what is owed against this filename — the
// `001_ssltests.spec.ts` and `005_negotiate_encryption.spec.ts` files
// follow the same pattern for their out-of-scope rows.
// ---------------------------------------------------------------------------

describe('tap/004_load_balance_dns (skipped — pending DNS fan-out)', () => {
  it.skip(
    'load_balance_hosts=disable connects to the first DNS-returned IP' +
      ' (upstream: connect1 hits node1)',
    () => {
      /* unreachable until WIRE_DNS_FANOUT_DONE */
    },
  );

  it.skip(
    'load_balance_hosts=random spreads 50 connections across the 3' +
      ' DNS-returned IPs (upstream: connect2, p≈1.6e-9 of missing any node)',
    () => {
      /* unreachable until WIRE_DNS_FANOUT_DONE */
    },
  );

  it.skip(
    'each of node1/node2/node3 receives at least one connect2 connection' +
      " (upstream: 3× node->log_content =~ /SELECT 'connect2'/g)",
    () => {
      /* unreachable until WIRE_DNS_FANOUT_DONE */
    },
  );

  it.skip(
    'load_balance_hosts=disable falls through to a working node when' +
      ' earlier ones are down (upstream: connect3 after stopping node1+2)',
    () => {
      /* unreachable until WIRE_DNS_FANOUT_DONE */
    },
  );

  it.skip(
    'load_balance_hosts=random also falls through to a working node when' +
      ' earlier ones are down (upstream: connect4 × 5 after stopping' +
      ' node1+2)',
    () => {
      /* unreachable until WIRE_DNS_FANOUT_DONE */
    },
  );
});
