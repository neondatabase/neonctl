# Custom docker image for the upstream PG `004_load_balance_dns.pl` port.
#
# What this image provides:
#   1. Three independent postgres clusters, each bound to a different
#      loopback address (127.0.0.1, 127.0.0.2, 127.0.0.3) on port 5432.
#   2. /etc/hosts entries mapping the hostname `pg-loadbalancetest` to
#      all three of those addresses, so a single getaddrinfo lookup
#      returns three IPs (mimicking round-robin DNS without standing
#      up a DNS server).
#
# WHY this is in its own image (rather than the shared postgres:18.0 the
# rest of the conformance harness uses):
#   * The hosts-file lines need 3 separate IPs that the kernel will let
#     us bind to (Linux only — see upstream's own skip on non-Linux/Win).
#   * The base postgres image only runs ONE cluster. We need 3, on
#     different listen_addresses, sharing a port.
#   * Containers re-generate /etc/hosts on every start (managed by
#     Docker), so the hosts-file entries are written by the entrypoint
#     at container start, not baked in at build.
#
# Why this file is committed but NOT auto-built by the harness:
#   * Building it requires Docker + the test must run on a Linux host
#     (loopback aliases 127.0.0.2/3 only bind on Linux/Windows). macOS
#     and the typical macOS-laptop dev workflow can't host this — we
#     don't want to slow down `bun run test:psql-conformance` for the
#     common case.
#   * The companion spec at `tests/psql-conformance/tap/004_load_balance_dns.spec.ts`
#     currently skips with a documented reason; once the wire layer
#     learns to fan a single hostname out to its DNS addresses, the
#     spec will be flipped and this image becomes the live fixture.
#
# Manual build (when iterating):
#   docker build -f tests/psql-conformance/fixtures/loadbalance-dns/Dockerfile \
#     -t pg-loadbalance-dns tests/psql-conformance/fixtures/loadbalance-dns

FROM postgres:18.0

# We need three independent data dirs. PGDATA from the base image is
# /var/lib/postgresql/data; we provide a parallel root for our three
# clusters so we don't conflict with the base image's default cluster.
ENV PG_LB_ROOT=/var/lib/pg-lb
RUN mkdir -p "$PG_LB_ROOT/node1" "$PG_LB_ROOT/node2" "$PG_LB_ROOT/node3" && \
    chown -R postgres:postgres "$PG_LB_ROOT"

# initdb runs as the `postgres` user. Each cluster owns its own data
# directory; all three share TCP port 5432 but bind to different
# loopback addresses (set in the entrypoint).
USER postgres
RUN initdb -D "$PG_LB_ROOT/node1" --username=postgres --auth=trust && \
    initdb -D "$PG_LB_ROOT/node2" --username=postgres --auth=trust && \
    initdb -D "$PG_LB_ROOT/node3" --username=postgres --auth=trust
USER root

# Entrypoint:
#   * Writes the three hosts-file entries for pg-loadbalancetest.
#   * Starts all three postgres clusters in the background, each on a
#     different listen_addresses.
#   * Tails the postmaster logs so docker logs has something to show.
#   * Waits forever; container teardown signals the children.
COPY entrypoint.sh /usr/local/bin/loadbalance-entrypoint.sh
RUN chmod +x /usr/local/bin/loadbalance-entrypoint.sh

# Single Postgres port. The host-side test connects to 127.0.0.1:5432
# of the container's three internal addresses — but in practice the
# host can only reach ONE of them through docker port-mapping. That is
# the structural limitation explained in the spec header: the upstream
# test asserts the CLIENT iterates DNS results, which only works when
# all three IPs are reachable from the client. A real port likely
# requires running the spec INSIDE this container (vitest-in-container)
# or using a host network namespace (--network=host on Linux).
EXPOSE 5432

ENTRYPOINT ["/usr/local/bin/loadbalance-entrypoint.sh"]
