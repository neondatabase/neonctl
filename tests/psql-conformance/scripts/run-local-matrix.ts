/**
 * Local conformance matrix runner.
 *
 * Iterates a list of postgres major versions (Neon's support range: 14-18),
 * boots a separate testcontainer for each, runs the conformance suite
 * against `dist/psql/cli.js` (the standalone embedded-psql shim), and
 * prints a summary table comparing pass / fail / skipped counts per
 * version.
 *
 * Mirrors `.github/workflows/psql-conformance.yml`'s matrix without
 * requiring GitHub Actions. Useful for:
 *   - Pre-PR sanity check across the full PG range
 *   - Local triage of a single failing version (`--pg 17` flag)
 *
 * Subtests that don't yet pass against the TS implementation should be
 * marked `it.todo("reason")` (engine gap) or `it.skip("reason")` (out of
 * scope) in their spec file — the matrix runner just collects counts.
 *
 * Usage:
 *   bun tests/psql-conformance/scripts/run-local-matrix.ts
 *   bun tests/psql-conformance/scripts/run-local-matrix.ts --pg 17 --pg 18
 *   bun tests/psql-conformance/scripts/run-local-matrix.ts --skip-build
 *
 * Exit codes:
 *   0 — every requested version completed without failures
 *   1 — at least one version had failures
 *   2 — usage / setup error (Docker missing, build failure, etc.)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type MajorVersion = '14' | '15' | '16' | '17' | '18';

const DEFAULT_MATRIX: readonly { pg: MajorVersion; image: string }[] = [
  { pg: '14', image: 'postgres:14.13' },
  { pg: '15', image: 'postgres:15.8' },
  { pg: '16', image: 'postgres:16.4' },
  { pg: '17', image: 'postgres:17.4' },
  { pg: '18', image: 'postgres:18.0' },
];

type PerSpecRollup = {
  spec: string;
  passed: number;
  failed: number;
  skipped: number;
};

type PerVersionResult = {
  pg: MajorVersion;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  failedAny: boolean;
  errored: boolean;
  message?: string;
  bySpec?: readonly PerSpecRollup[];
};

type Args = {
  versions: readonly { pg: MajorVersion; image: string }[];
  skipBuild: boolean;
  help: boolean;
};

const log = (msg: string): void => {
  process.stderr.write(`[matrix] ${msg}\n`);
};

const printUsage = (): void => {
  process.stderr.write(
    [
      'Usage: bun tests/psql-conformance/scripts/run-local-matrix.ts [options]',
      '',
      'Options:',
      '  --pg <14|15|16|17|18>   Limit the matrix to this version (repeatable).',
      '                          Default: all five.',
      '  --skip-build            Reuse the existing dist/ tree instead of running',
      '                          `bun run build` upfront.',
      '  --help                  Print this help.',
      '',
      'Requires Docker (or compatible) running locally for testcontainers.',
      'Each matrix slot spins up + tears down its own postgres container, so',
      'they do not contend on a single port and one slot can fail without',
      'affecting another.',
    ].join('\n') + '\n',
  );
};

const parseArgs = (argv: string[]): Args => {
  let skipBuild = false;
  let help = false;
  const selected = new Set<MajorVersion>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') help = true;
    else if (a === '--skip-build') skipBuild = true;
    else if (a === '--pg') {
      const v = argv[++i];
      if (v && (['14', '15', '16', '17', '18'] as string[]).includes(v)) {
        selected.add(v as MajorVersion);
      } else {
        process.stderr.write(
          `error: --pg expects one of 14|15|16|17|18, got ${String(v)}\n`,
        );
        process.exit(2);
      }
    } else if (a.startsWith('--pg=')) {
      const v = a.slice(5);
      if ((['14', '15', '16', '17', '18'] as string[]).includes(v)) {
        selected.add(v as MajorVersion);
      } else {
        process.stderr.write(
          `error: --pg expects one of 14|15|16|17|18, got ${v}\n`,
        );
        process.exit(2);
      }
    } else {
      process.stderr.write(`error: unknown arg ${a}\n`);
      process.exit(2);
    }
  }
  const versions =
    selected.size === 0
      ? DEFAULT_MATRIX
      : DEFAULT_MATRIX.filter((v) => selected.has(v.pg));
  return { versions, skipBuild, help };
};

const ensureBuild = (skipBuild: boolean): void => {
  const distEntry = join(process.cwd(), 'dist', 'psql', 'cli.js');
  if (skipBuild) {
    if (!existsSync(distEntry)) {
      process.stderr.write(
        `error: --skip-build set but ${distEntry} not found. Run \`bun run build\` first.\n`,
      );
      process.exit(2);
    }
    log('--skip-build: reusing existing dist/');
    return;
  }
  log('Building dist/ (`bun run build`)...');
  const r = spawnSync('bun', ['run', 'build'], { stdio: 'inherit' });
  if (r.status !== 0) {
    process.stderr.write('error: bun run build failed\n');
    process.exit(2);
  }
};

const bootContainer = async (
  image: string,
): Promise<{
  host: string;
  port: number;
  user: string;
  password: string;
  db: string;
  absBuilddir: string;
  stop: () => Promise<void>;
}> => {
  const moduleName = '@testcontainers/postgresql';
  let mod: { PostgreSqlContainer: new (img: string) => unknown };
  try {
    mod = (await import(moduleName)) as never;
  } catch {
    process.stderr.write(
      [
        'error: @testcontainers/postgresql is not installed.',
        '',
        'Install with:  bun add -d @testcontainers/postgresql',
      ].join('\n') + '\n',
    );
    process.exit(2);
  }
  type BindMount = { source: string; target: string; mode?: 'ro' | 'rw' };
  type ContainerHandle = {
    withDatabase(db: string): ContainerHandle;
    withUsername(u: string): ContainerHandle;
    withPassword(p: string): ContainerHandle;
    withBindMounts(mounts: BindMount[]): ContainerHandle;
    start(): Promise<{
      getHost(): string;
      getMappedPort(p: number): number;
      stop(): Promise<unknown>;
    }>;
  };
  // Allocate abs_builddir up-front and bind-mount it into the container
  // so `\g :'g_out_file'` (host writes) and `COPY ... FROM :'g_out_file'`
  // (server reads) see the same path. Mirrors pg-fixture.ts setup —
  // without it, the server can't see files the client writes.
  const fs = await import('node:fs');
  const absBuilddir = fs.mkdtempSync(
    join(tmpdir(), 'psql-conformance-regress-'),
  );
  fs.chmodSync(absBuilddir, 0o755);
  fs.mkdirSync(join(absBuilddir, 'results'), { recursive: true, mode: 0o777 });
  const built = new mod.PostgreSqlContainer(image) as ContainerHandle;
  const started = await built
    .withDatabase('regression')
    .withUsername('postgres')
    .withPassword('postgres')
    .withBindMounts([{ source: absBuilddir, target: absBuilddir, mode: 'rw' }])
    .start();
  // Seed `onek` / `tenk1` (with the unique2 index) so the upstream
  // regress/psql.sql references — and chunked-cursor FETCH_COUNT test —
  // resolve. pg-fixture.ts seeds via its own setup path; the matrix
  // runner takes the env-var bypass which skips that, so we mirror the
  // seed here.
  const seedPath = join(
    process.cwd(),
    'tests',
    'psql-conformance',
    'seed',
    'test_setup_minimal.sql',
  );
  if (existsSync(seedPath)) {
    const host = started.getHost();
    const port = started.getMappedPort(5432);
    const seedResult = spawnSync(
      'psql',
      [
        '-v',
        'ON_ERROR_STOP=1',
        '-h',
        host,
        '-p',
        String(port),
        '-U',
        'postgres',
        '-d',
        'regression',
        '-f',
        seedPath,
      ],
      {
        env: { ...process.env, PGPASSWORD: 'postgres' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (seedResult.status !== 0) {
      const err = (seedResult.stderr ?? Buffer.alloc(0)).toString();
      process.stderr.write(
        `[matrix] warning: seed script failed (status ${String(seedResult.status)}):\n${err.slice(0, 400)}\n`,
      );
    }
  }
  return {
    host: started.getHost(),
    port: started.getMappedPort(5432),
    user: 'postgres',
    password: 'postgres',
    db: 'regression',
    absBuilddir,
    stop: async () => {
      await started.stop();
      try {
        fs.rmSync(absBuilddir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
};

const runConformance = (
  pg: MajorVersion,
  pgConn: {
    host: string;
    port: number;
    user: string;
    password: string;
    db: string;
  },
): PerVersionResult => {
  const psqlBinary = join(process.cwd(), 'dist', 'psql', 'cli.js');
  const tmpReport = mkdtempSync(join(tmpdir(), `psql-conf-${pg}-`));
  const reportFile = join(tmpReport, 'report.json');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PSQL_BINARY: psqlBinary,
    // Opt in to TAP-style integration specs (`tap/001_basic.spec.ts`,
    // `tap/030_pager.spec.ts`, etc.). They self-skip when this env var
    // is missing so they don't slow down the default `bun run test`
    // suite — but the matrix is exactly where we want them to run.
    RUN_INTEGRATION: '1',
    PGCONFORMANCE_PG_HOST: pgConn.host,
    PGCONFORMANCE_PG_PORT: String(pgConn.port),
    PGCONFORMANCE_PG_USER: pgConn.user,
    PGCONFORMANCE_PG_PASSWORD: pgConn.password,
    PGCONFORMANCE_PG_DB: pgConn.db,
    // abs_builddir is bind-mounted into the container at the same
    // path; surface it so regress.spec.ts reuses it instead of allocating
    // its own (would land on a different inode the container can't see).
    PGCONFORMANCE_ABS_BUILDDIR: pgConn.absBuilddir,
    // Surface the slot's PG major so the harness can apply
    // version-conditional normalize rules without round-tripping
    // through the server-side probe (the GHA path uses the same env
    // var; bootTestcontainer path autodetects).
    PGCONFORMANCE_PG_MAJOR: pg,
  };

  const r = spawnSync(
    'bunx',
    [
      'vitest',
      'run',
      '--config',
      'tests/psql-conformance/vitest.config.ts',
      '--reporter=json',
      `--outputFile=${reportFile}`,
    ],
    {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Defensive ceiling so a stuck vitest process can't freeze the
      // matrix forever. vitest itself enforces testTimeout: 120_000 and
      // hookTimeout: 180_000 per the conformance vitest.config.ts; with
      // ~30 test files this caps total work at ~10min. A 15min outer
      // timeout swallows that plus container teardown overhead and still
      // catches a true infinite loop.
      timeout: 15 * 60 * 1000,
    },
  );

  if (!existsSync(reportFile)) {
    return {
      pg,
      passed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      failedAny: true,
      errored: true,
      message:
        r.error?.message ??
        `vitest exited with code ${String(r.status)}: ${r.stderr.toString().trim().slice(0, 200)}`,
    };
  }

  let report: {
    numTotalTests?: number;
    numPassedTests?: number;
    numFailedTests?: number;
    testResults?: readonly {
      name?: string;
      assertionResults?: readonly {
        status?: string;
        title?: string;
        ancestorTitles?: readonly string[];
      }[];
    }[];
  };
  try {
    report = JSON.parse(readFileSync(reportFile, 'utf8')) as never;
  } catch (err) {
    return {
      pg,
      passed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      failedAny: true,
      errored: true,
      message: `failed to parse JSON report: ${(err as Error).message}`,
    };
  }

  const passed = report.numPassedTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  const total = report.numTotalTests ?? passed + failed;
  const failedAny = failed > 0;
  // Count skipped assertions (vitest treats `ctx.skip(...)` calls as
  // status: 'skipped'; they don't fail, so they count toward `passed`
  // in the summary). Surfacing the count keeps the matrix output
  // honest when version-conditional specs opt out on older PGs.
  let skipped = 0;
  const bySpec: PerSpecRollup[] = [];
  for (const tr of report.testResults ?? []) {
    // Strip path + suffix so the rollup is "001_basic" not the full
    // absolute path of `tap/001_basic.spec.ts`. Stays stable across
    // runs and short enough to fit the summary table.
    const spec = (tr.name ?? '')
      .split('/')
      .pop()!
      .replace(/\.(spec|test)\.ts$/, '');
    const rollup: PerSpecRollup = { spec, passed: 0, failed: 0, skipped: 0 };
    for (const a of tr.assertionResults ?? []) {
      if (a.status === 'passed') rollup.passed += 1;
      else if (a.status === 'failed') rollup.failed += 1;
      else if (a.status === 'skipped' || a.status === 'pending') {
        rollup.skipped += 1;
        skipped += 1;
      }
    }
    bySpec.push(rollup);
  }
  // Stable ordering: failures first (visibility), then by spec name.
  bySpec.sort((a, b) => {
    if (a.failed !== b.failed) return b.failed - a.failed;
    return a.spec.localeCompare(b.spec);
  });

  // Write the full report alongside the cwd for triage.
  const persistedDir = join(process.cwd(), 'tmp', 'psql-conformance');
  try {
    spawnSync('mkdir', ['-p', persistedDir]);
    writeFileSync(
      join(persistedDir, `pg-${pg}.json`),
      JSON.stringify(report, null, 2),
    );
  } catch {
    // best-effort
  }

  return {
    pg,
    passed,
    failed,
    skipped,
    total,
    failedAny,
    errored: false,
    bySpec,
  };
};

const renderSummary = (results: readonly PerVersionResult[]): string => {
  const lines: string[] = [];
  lines.push('');
  lines.push('Conformance matrix summary');
  lines.push('==========================');
  lines.push('');
  lines.push('  PG    Total   Passed   Failed   Skipped   Status');
  lines.push('  ----  ------  -------  -------  --------  ------');
  for (const r of results) {
    const status = r.errored ? 'ERRORED' : r.failedAny ? 'FAIL' : 'OK';
    lines.push(
      `  ${r.pg.padEnd(4)}  ${String(r.total).padStart(6)}  ${String(r.passed).padStart(7)}  ${String(r.failed).padStart(7)}  ${String(r.skipped).padStart(8)}  ${status}`,
    );
    if (r.message) lines.push(`        └─ ${r.message}`);
    // Per-spec breakdown. Only printed when there's a failure OR the
    // spec has at least one skipped/pending — keeps the summary tight
    // in the all-green-no-skips case while still surfacing what's
    // skipped so the aggregate "passed" can be interpreted honestly.
    for (const s of r.bySpec ?? []) {
      if (s.failed === 0 && s.skipped === 0) continue;
      const parts: string[] = [];
      parts.push(`pass=${s.passed}`);
      if (s.failed > 0) parts.push(`fail=${s.failed}`);
      if (s.skipped > 0) parts.push(`skip=${s.skipped}`);
      lines.push(`        └─ ${s.spec.padEnd(28)} ${parts.join(' ')}`);
    }
  }
  lines.push('');
  lines.push(
    `Per-version JSON reports: ${join(process.cwd(), 'tmp', 'psql-conformance', 'pg-<N>.json')}`,
  );
  lines.push('');
  return lines.join('\n');
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }

  ensureBuild(args.skipBuild);

  const results: PerVersionResult[] = [];
  for (const slot of args.versions) {
    log(`-- PG ${slot.pg} (${slot.image}) --`);
    let pgConn: Awaited<ReturnType<typeof bootContainer>> | null = null;
    try {
      pgConn = await bootContainer(slot.image);
      log(`booted; connecting at ${pgConn.host}:${pgConn.port}`);
      const r = runConformance(slot.pg, pgConn);
      results.push(r);
      log(
        `done: total=${r.total} passed=${r.passed} failed=${r.failed} skipped=${r.skipped} status=${
          r.errored ? 'ERRORED' : r.failedAny ? 'FAIL' : 'OK'
        }`,
      );
    } catch (err) {
      results.push({
        pg: slot.pg,
        passed: 0,
        failed: 0,
        skipped: 0,
        total: 0,
        failedAny: true,
        errored: true,
        message: (err as Error).message,
      });
      log(`ERRORED: ${(err as Error).message}`);
    } finally {
      if (pgConn) {
        try {
          await pgConn.stop();
        } catch {
          // best-effort
        }
      }
    }
  }

  process.stdout.write(renderSummary(results));
  const anyFail = results.some((r) => r.failedAny || r.errored);
  process.exit(anyFail ? 1 : 0);
};

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(2);
});
