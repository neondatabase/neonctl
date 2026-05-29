--
-- Minimal subset of upstream src/test/regress/sql/test_setup.sql, adapted
-- for the psql-conformance harness.
--
-- Upstream test_setup.sql is the first script every pg_regress invocation
-- runs; the vendored regression scripts we drive (psql.sql, psql_pipeline.sql,
-- psql_crosstab.sql) assume the tables it creates already exist. Running it
-- verbatim against a stock `postgres:18.0` container fails because it
-- references regresslib (a C library built only as part of the regression
-- test suite, not shipped in the image): binary_coercible, ttdummy,
-- part_hashint4_noop, etc.
--
-- This script keeps just the table schemas the vendored psql.sql / pipeline /
-- crosstab scripts actually reference (`onek`, `tenk1`) and populates them
-- via generate_series rather than COPY-FROM data files. Coverage is small:
-- psql.sql only reads onek.unique1 (and expects max(unique1)=999) and
-- tenk1.unique2 (ORDER BY unique2 LIMIT 19, then 1/(15-unique2) which must
-- divide-by-zero at unique2=15). generate_series(0,999) and (0,9999) cover
-- both.
--
-- Run this from harness/pg-fixture.ts via `psql -f` after the container
-- boots and before the per-spec invocations begin.

-- Postgres formerly made the public schema read/write by default, and the
-- vendored psql.sql still expects that.
GRANT ALL ON SCHEMA public TO public;

-- Upstream's create_am.sql regression test runs before psql.sql in the
-- standard parallel_schedule and installs a second table access method
-- named `heap2` (using the same handler as `heap`). psql.sql then
-- inspects it via `\dA`, `\dA *`, `\dA h*`, `\dA+`, etc. We don't run
-- the full schedule, so install heap2 here to keep those checks green.
CREATE ACCESS METHOD heap2 TYPE TABLE HANDLER heap_tableam_handler;

-- onek: 1000 rows. psql.sql uses .unique1 only.
CREATE TABLE onek (
    unique1     int4,
    unique2     int4,
    two         int4,
    four        int4,
    ten         int4,
    twenty      int4,
    hundred     int4,
    thousand    int4,
    twothousand int4,
    fivethous   int4,
    tenthous    int4,
    odd         int4,
    even        int4,
    stringu1    name,
    stringu2    name,
    string4     name
);

INSERT INTO onek (unique1, unique2)
SELECT i, i FROM generate_series(0, 999) AS gs(i);

VACUUM ANALYZE onek;

-- tenk1: 10000 rows. psql.sql uses .unique2 only (ORDER BY unique2 LIMIT 19,
-- then 1/(15-unique2) — must include unique2=15 to trigger the divide-by-zero
-- the expected output checks for).
CREATE TABLE tenk1 (
    unique1     int4,
    unique2     int4,
    two         int4,
    four        int4,
    ten         int4,
    twenty      int4,
    hundred     int4,
    thousand    int4,
    twothousand int4,
    fivethous   int4,
    tenthous    int4,
    odd         int4,
    even        int4,
    stringu1    name,
    stringu2    name,
    string4     name
);

INSERT INTO tenk1 (unique1, unique2)
SELECT i, i FROM generate_series(0, 9999) AS gs(i);

VACUUM ANALYZE tenk1;
