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

type PerVersionResult = {
  pg: MajorVersion;
  passed: number;
  failed: number;
  total: number;
  failedAny: boolean;
  errored: boolean;
  message?: string;
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
  type ContainerHandle = {
    withDatabase(db: string): ContainerHandle;
    withUsername(u: string): ContainerHandle;
    withPassword(p: string): ContainerHandle;
    start(): Promise<{
      getHost(): string;
      getMappedPort(p: number): number;
      stop(): Promise<unknown>;
    }>;
  };
  const built = new mod.PostgreSqlContainer(image) as ContainerHandle;
  const started = await built
    .withDatabase('regression')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();
  return {
    host: started.getHost(),
    port: started.getMappedPort(5432),
    user: 'postgres',
    password: 'postgres',
    db: 'regression',
    stop: async () => {
      await started.stop();
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
    PGCONFORMANCE_PG_HOST: pgConn.host,
    PGCONFORMANCE_PG_PORT: String(pgConn.port),
    PGCONFORMANCE_PG_USER: pgConn.user,
    PGCONFORMANCE_PG_PASSWORD: pgConn.password,
    PGCONFORMANCE_PG_DB: pgConn.db,
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
    total,
    failedAny,
    errored: false,
  };
};

const renderSummary = (results: readonly PerVersionResult[]): string => {
  const lines: string[] = [];
  lines.push('');
  lines.push('Conformance matrix summary');
  lines.push('==========================');
  lines.push('');
  lines.push('  PG    Total   Passed   Failed   Status');
  lines.push('  ----  ------  -------  -------  ------');
  for (const r of results) {
    const status = r.errored ? 'ERRORED' : r.failedAny ? 'FAIL' : 'OK';
    lines.push(
      `  ${r.pg.padEnd(4)}  ${String(r.total).padStart(6)}  ${String(r.passed).padStart(7)}  ${String(r.failed).padStart(7)}  ${status}`,
    );
    if (r.message) lines.push(`        └─ ${r.message}`);
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
        `done: total=${r.total} passed=${r.passed} failed=${r.failed} status=${
          r.errored ? 'ERRORED' : r.failedAny ? 'FAIL' : 'OK'
        }`,
      );
    } catch (err) {
      results.push({
        pg: slot.pg,
        passed: 0,
        failed: 0,
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
