#!/usr/bin/env bun
// Refresh the vendored upstream PostgreSQL regression scripts.
//
// Usage:
//   bun tests/psql-conformance/scripts/refresh-vendored.ts            # use POSTGRES_REF
//   bun tests/psql-conformance/scripts/refresh-vendored.ts REL_18_1   # override tag
//
// Steps:
//   1. Read tests/psql-conformance/POSTGRES_REF
//   2. Resolve the override tag against the GitHub API to get a commit sha
//   3. Download each vendored file at that tag
//   4. Rewrite POSTGRES_REF (PG_VERSION + PG_TAG + PG_COMMIT)
//   5. Rewrite vendor/postgres-<version>/VENDORED_FROM

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFORMANCE_ROOT = resolve(HERE, '..');
const POSTGRES_REF_PATH = join(CONFORMANCE_ROOT, 'POSTGRES_REF');

type Ref = {
  pgVersion: string;
  pgTag: string;
  pgCommit: string;
  pgImage: string;
  pgImageDigest: string;
};

type RefreshTarget = {
  destRelative: string; // relative to vendor/postgres-<version>/
  upstreamPath: string; // relative to repo root in postgres/postgres
};

const TARGETS: readonly RefreshTarget[] = [
  {
    destRelative: 'src/test/regress/sql/psql.sql',
    upstreamPath: 'src/test/regress/sql/psql.sql',
  },
  {
    destRelative: 'src/test/regress/sql/psql_crosstab.sql',
    upstreamPath: 'src/test/regress/sql/psql_crosstab.sql',
  },
  {
    destRelative: 'src/test/regress/sql/psql_pipeline.sql',
    upstreamPath: 'src/test/regress/sql/psql_pipeline.sql',
  },
  {
    destRelative: 'src/test/regress/expected/psql.out',
    upstreamPath: 'src/test/regress/expected/psql.out',
  },
  {
    destRelative: 'src/test/regress/expected/psql_crosstab.out',
    upstreamPath: 'src/test/regress/expected/psql_crosstab.out',
  },
  {
    destRelative: 'src/test/regress/expected/psql_pipeline.out',
    upstreamPath: 'src/test/regress/expected/psql_pipeline.out',
  },
  {
    destRelative: 'src/bin/psql/t/001_basic.pl',
    upstreamPath: 'src/bin/psql/t/001_basic.pl',
  },
  {
    destRelative: 'src/bin/psql/t/010_tab_completion.pl',
    upstreamPath: 'src/bin/psql/t/010_tab_completion.pl',
  },
  {
    destRelative: 'src/bin/psql/t/020_cancel.pl',
    upstreamPath: 'src/bin/psql/t/020_cancel.pl',
  },
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const overrideTag = argv[0];

  const ref = readRef();
  if (overrideTag && overrideTag !== ref.pgTag) {
    out(`overriding pg tag ${ref.pgTag} -> ${overrideTag}`);
    ref.pgTag = overrideTag;
    ref.pgVersion = tagToVersion(overrideTag);
  }

  out(`resolving commit sha for ${ref.pgTag}...`);
  ref.pgCommit = await resolveCommit(ref.pgTag);
  out(`  ${ref.pgTag} -> ${ref.pgCommit}`);

  const vendorDir = resolve(
    CONFORMANCE_ROOT,
    'vendor',
    `postgres-${ref.pgVersion}`,
  );
  out(`writing to ${vendorDir}`);

  for (const t of TARGETS) {
    const url = `https://raw.githubusercontent.com/postgres/postgres/${ref.pgTag}/${t.upstreamPath}`;
    const destPath = join(vendorDir, t.destRelative);
    mkdirSync(dirname(destPath), { recursive: true });
    try {
      const body = await fetchText(url);
      writeFileSync(destPath, body, 'utf8');
      out(`  ${ref.pgTag}:${t.upstreamPath} (${body.length} bytes)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out(`  WARN: ${ref.pgTag}:${t.upstreamPath} skipped: ${msg}`);
    }
  }

  writeRef(ref);
  writeVendoredFrom(vendorDir, ref);
  out('done.');
}

function readRef(): Ref {
  const raw = readFileSync(POSTGRES_REF_PATH, 'utf8');
  const map = parseEnvFile(raw);
  return {
    pgVersion: required(map, 'PG_VERSION'),
    pgTag: required(map, 'PG_TAG'),
    pgCommit: required(map, 'PG_COMMIT'),
    pgImage: required(map, 'PG_IMAGE'),
    pgImageDigest: required(map, 'PG_IMAGE_DIGEST'),
  };
}

function writeRef(ref: Ref): void {
  const current = readFileSync(POSTGRES_REF_PATH, 'utf8');
  const updated = current
    .replace(/^PG_VERSION=.*$/m, `PG_VERSION=${ref.pgVersion}`)
    .replace(/^PG_TAG=.*$/m, `PG_TAG=${ref.pgTag}`)
    .replace(/^PG_COMMIT=.*$/m, `PG_COMMIT=${ref.pgCommit}`);
  writeFileSync(POSTGRES_REF_PATH, updated, 'utf8');
}

function writeVendoredFrom(vendorDir: string, ref: Ref): void {
  const today = new Date().toISOString().slice(0, 10);
  const body = `Vendored from the upstream PostgreSQL source tree.

Primary source:
  https://github.com/postgres/postgres
  tag: ${ref.pgTag}
  commit: ${ref.pgCommit}
  date vendored: ${today}

Files vendored at ${ref.pgTag}:
  src/test/regress/sql/psql.sql
  src/test/regress/sql/psql_crosstab.sql
  src/test/regress/sql/psql_pipeline.sql
  src/test/regress/expected/psql.out
  src/test/regress/expected/psql_crosstab.out
  src/test/regress/expected/psql_pipeline.out
  src/bin/psql/t/001_basic.pl
  src/bin/psql/t/010_tab_completion.pl
  src/bin/psql/t/020_cancel.pl

License: PostgreSQL License (BSD-style). The PostgreSQL Global
Development Group retains copyright. See:
  https://www.postgresql.org/about/licence/

This file is regenerated by:
  bun tests/psql-conformance/scripts/refresh-vendored.ts
`;
  writeFileSync(join(vendorDir, 'VENDORED_FROM'), body, 'utf8');
}

function parseEnvFile(raw: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    m.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return m;
}

function required(m: Map<string, string>, key: string): string {
  const v = m.get(key);
  if (v === undefined || v === '') {
    throw new Error(`POSTGRES_REF is missing required key ${key}`);
  }
  return v;
}

function tagToVersion(tag: string): string {
  const m = /^REL_(\d+)_(\d+)$/.exec(tag);
  if (!m) {
    throw new Error(
      `cannot derive version from tag "${tag}" (expected REL_<major>_<minor>)`,
    );
  }
  return `${m[1]}.${m[2]}`;
}

async function resolveCommit(tag: string): Promise<string> {
  const url = `https://api.github.com/repos/postgres/postgres/commits/${tag}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${tag}: ${await res.text()}`);
  }
  const body = (await res.json()) as { sha?: string };
  if (typeof body.sha !== 'string') {
    throw new Error(`GitHub API: no sha in response for ${tag}`);
  }
  return body.sha;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

function out(msg: string): void {
  process.stderr.write(`[refresh-vendored] ${msg}\n`);
}

await main();
