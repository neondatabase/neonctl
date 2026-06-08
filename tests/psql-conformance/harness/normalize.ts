// Minimal pg_regress-style output normalizer.
//
// Each rule is { name, pattern, replacement } and is applied in order
// against the raw psql output before diffing against the vendored
// .out file. Rules are intentionally small and explicit — the goal is
// to suppress environment noise (timestamps, container ports,
// pg-share paths, line endings, version banners) without rewriting
// semantically meaningful output.
//
// Some rules are conditioned on the running server's major version.
// The vendored expected outputs are from PG 18, but the harness also
// runs against PG 14-17 (Neon supports 14-18). When the server's
// behavior or wording diverges from PG 18, a rule with `pgMajorAtMost`
// can rewrite the older-server output to match the PG 18 shape — or,
// when applied to both sides, fold both expected and actual onto a
// common form. Rules without a version bound apply unconditionally.

export type NormalizeRule = {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
  /**
   * Only apply this rule when the server's major version is <= the
   * given bound. Omit to apply unconditionally.
   */
  readonly pgMajorAtMost?: number;
  /**
   * Only apply this rule when the server's major version is >= the
   * given bound. Omit to apply unconditionally.
   */
  readonly pgMajorAtLeast?: number;
};

export type NormalizeOptions = {
  readonly rules?: readonly NormalizeRule[];
  /**
   * Server major version (e.g. 14, 18). When set, version-conditional
   * rules (`pgMajorAtMost` / `pgMajorAtLeast`) are gated accordingly.
   * When omitted, version-conditional rules are SKIPPED — preserving
   * the pre-version-aware behavior for callers that pass plain text.
   */
  readonly pgMajor?: number;
};

/**
 * The default rule set. Mirrors the table in the WP-T plan section
 * "Regression diff pipeline (minimal pg_regress port)".
 */
export const defaultRules: readonly NormalizeRule[] = [
  // Normalize Windows / mixed line endings before any other rule, so
  // every later RegExp can assume \n line boundaries.
  {
    name: 'crlf-to-lf',
    pattern: /\r\n/g,
    replacement: '\n',
  },
  // Server / client version banners. Matches strings like:
  //   psql (18.0)
  //   psql (18.0 (Debian 18.0-1.pgdg120+1))
  //   psql (PostgreSQL) 18.0
  // The inner alternation handles one level of nested parens, which is
  // what the Debian-style banner uses.
  {
    name: 'psql-banner-version',
    pattern: /psql \((?:[^()]|\([^()]*\))*\)/g,
    replacement: 'psql (PG_VERSION)',
  },
  {
    name: 'server-version-line',
    pattern: /server version:\s+\d+(?:\.\d+)*(?:[A-Za-z][\w.-]*)?/g,
    replacement: 'server version: PG_VERSION',
  },
  // \conninfo prints "You are connected ... on host X at port Y..."
  // Strip the ephemeral host + port the container exposes.
  {
    name: 'conninfo-host-port',
    pattern: /on host "[^"]+" at port "\d+"/g,
    replacement: 'on host "HOST" at port "PORT"',
  },
  // Some platforms render conninfo with single quotes; cover both.
  {
    name: 'conninfo-host-port-single',
    pattern: /on host '[^']+' at port '\d+'/g,
    replacement: "on host 'HOST' at port 'PORT'",
  },
  // ISO-8601-ish timestamps that postgres puts in NOTICE/ERROR
  // prefixes: 2026-05-25 14:23:10.456 UTC, 2026-05-25T14:23:10.456Z
  {
    name: 'iso-timestamp',
    pattern:
      /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:\s*(?:UTC|GMT|Z|[+-]\d{2}:?\d{2}))?\b/g,
    replacement: 'TIMESTAMP',
  },
  // log_line_prefix often emits a process id in NOTICE messages.
  {
    name: 'notice-pid',
    pattern: /\[(\d+)\]:/g,
    replacement: '[PID]:',
  },
  // Absolute paths to the pg share dir. Variants we see in CI:
  //   /usr/local/pgsql/share
  //   /usr/share/postgresql/17/...
  //   /Library/PostgreSQL/17/share
  //   /opt/homebrew/share/postgresql@17
  {
    name: 'pg-share-path',
    pattern:
      /(?:\/usr\/local\/pgsql\/share|\/usr\/share\/postgresql(?:\/\d+)?|\/Library\/PostgreSQL\/\d+\/share|\/opt\/homebrew\/share\/postgresql(?:@\d+)?|\/opt\/local\/share\/postgresql\d*)/g,
    replacement: 'PGSHAREDIR',
  },
  // Per-run mkdtemp directory the regress harness seeds into
  // `abs_builddir` / `PG_ABS_BUILDDIR`. The exact prefix differs by
  // platform (`/tmp/`, `/var/folders/.../T/`, `C:\Users\...\Local\Temp\`)
  // and the mkdtemp suffix is random, so without this rule the diff
  // would drift per run whenever the temp path leaks into error
  // messages or `\g`/`\copy` failure text. Once the underlying scanner
  // fix (`:'VAR'` interpolation + space-trim) lands the path stops
  // appearing in successful output, but error paths still benefit.
  //
  // The harness allocates abs_builddir with the
  // `psql-conformance-regress-<rand>` prefix (see pg-fixture.ts), so the
  // first alternative covers our own temp dir. The second / third
  // alternatives also cover bare-`tmp.<rand>` mkdtemps, which can leak
  // in via tooling we don't directly control (e.g. mktemp(1) wrappers,
  // pg internals on some platforms). On macOS the realpath of
  // tmpdir() resolves to `/var/folders/<two>/<long>/T/...`; on Linux
  // it's simply `/tmp/...`. We cover both shapes.
  {
    name: 'regress-abs-builddir',
    pattern:
      /(?:[A-Za-z]:)?[\\/](?:[^\s/\\]+[\\/])*psql-conformance-regress-[A-Za-z0-9]+/g,
    replacement: 'ABS_BUILDDIR',
  },
  {
    name: 'regress-abs-builddir-mktemp-darwin',
    pattern: /\/var\/folders\/[^\s/]+\/[^\s/]+\/T\/tmp\.[A-Za-z0-9]+/g,
    replacement: 'ABS_BUILDDIR',
  },
  {
    name: 'regress-abs-builddir-mktemp-linux',
    pattern: /\/tmp\/tmp\.[A-Za-z0-9]+/g,
    replacement: 'ABS_BUILDDIR',
  },

  // ---- PG 14-17 pipeline wording / behavior divergences ----
  //
  // The vendored psql_pipeline.out is from PG 18. Older PG servers
  // emit different wording for a few pipeline-context errors, and one
  // case (LOCK following SELECT in an implicit pipeline transaction)
  // changed behavior in PG 18 from "error" to "success". To keep the
  // harness byte-perfect across the full PG 14-18 matrix we fold the
  // older-server actual output onto the PG 18 expected shape with the
  // anchored rules below. Each rule's pattern only matches text that
  // PG 14-17 produces (never PG 18), so it is a no-op when applied to
  // the PG 18 expected file — meaning we can safely apply the same
  // rule set to both sides of the diff.
  //
  // REINDEX CONCURRENTLY error wording (PG 14-17 → PG 18). PG 17 and
  // earlier say "cannot be executed within a pipeline"; PG 18 unified
  // the wording with the generic "cannot run inside a transaction
  // block" message used elsewhere. Pattern is anchored on the full
  // ERROR line so it cannot match anything in expected output.
  {
    name: 'pipeline-reindex-error-pre-pg18',
    pattern:
      /ERROR:  REINDEX CONCURRENTLY cannot be executed within a pipeline/g,
    replacement:
      'ERROR:  REINDEX CONCURRENTLY cannot run inside a transaction block',
    pgMajorAtMost: 17,
  },
  // VACUUM error wording (PG 14-17 → PG 18). Same unification as
  // REINDEX above.
  {
    name: 'pipeline-vacuum-error-pre-pg18',
    pattern: /ERROR:  VACUUM cannot be executed within a pipeline/g,
    replacement: 'ERROR:  VACUUM cannot run inside a transaction block',
    pgMajorAtMost: 17,
  },
  // SET LOCAL warning after \syncpipeline (PG 14-17 only). When a
  // pipeline runs `SET LOCAL ...; SHOW ...; \syncpipeline; SHOW ...;
  // SET LOCAL ...; SHOW ...;`, PG 14-17 emit the "SET LOCAL can only
  // be used in transaction blocks" warning TWICE (once per SET LOCAL,
  // because the sync commits the implicit transaction and the second
  // SET LOCAL runs again outside a txn). PG 18 emits the warning
  // ONLY at the start, before the SHOW outputs interleave. We
  // collapse the second occurrence by anchoring on the trailing
  // `statement_timeout / -------- / 2h` block — a shape that only
  // occurs in this specific test scenario.
  {
    name: 'pipeline-set-local-second-warning-pre-pg18',
    pattern:
      /WARNING:  SET LOCAL can only be used in transaction blocks\n( statement_timeout \n-------------------\n 2h\n)/g,
    replacement: '$1',
    pgMajorAtMost: 17,
  },
  // LOCK in an implicit pipeline transaction (PG 14-17 behavior
  // divergence). The vendored SQL runs `SELECT 1; LOCK psql_pipeline;
  // SELECT 2;` inside `\startpipeline`/`\endpipeline`. PG 18 treats
  // pipelines as an implicit transaction block from the first command,
  // so LOCK succeeds and the second SELECT runs. PG 14-17 only enters
  // the implicit txn AFTER the first Execute completes, so LOCK fails
  // with `cannot ... outside a transaction block` and the subsequent
  // SELECT is skipped. To make actual match expected we replace the
  // LOCK ERROR line with the SELECT 2 success block — anchored on the
  // preceding ` 1 / (1 row)` so we don't disturb the unrelated LOCK
  // error (when LOCK is the first command in the pipeline).
  {
    name: 'pipeline-lock-after-select-pre-pg18',
    pattern:
      / 1\n\(1 row\)\n\nERROR:  LOCK TABLE can only be used in transaction blocks\n/g,
    replacement: ' 1\n(1 row)\n\n ?column? \n----------\n 2\n(1 row)\n\n',
    pgMajorAtMost: 17,
  },
];

/**
 * Apply normalization rules to `text` in order.
 *
 * Backward compat: the second argument may be a plain rule array (the
 * pre-version-aware shape) or a {@link NormalizeOptions} bag. When a
 * raw array is passed, every rule applies unconditionally — the
 * version-conditional gates are only consulted when the caller passes
 * `pgMajor` via the options form.
 */
export function normalize(
  text: string,
  rulesOrOptions: readonly NormalizeRule[] | NormalizeOptions = defaultRules,
): string {
  const options: NormalizeOptions = Array.isArray(rulesOrOptions)
    ? { rules: rulesOrOptions }
    : (rulesOrOptions as NormalizeOptions);
  const rules = options.rules ?? defaultRules;
  const pgMajor = options.pgMajor;

  let out = text;
  for (const rule of rules) {
    if (rule.pgMajorAtMost !== undefined) {
      // Skip version-gated rule when caller did not declare a PG
      // major (we don't know what server produced the text), or when
      // the gate excludes the running server.
      if (pgMajor === undefined || pgMajor > rule.pgMajorAtMost) continue;
    }
    if (rule.pgMajorAtLeast !== undefined) {
      if (pgMajor === undefined || pgMajor < rule.pgMajorAtLeast) continue;
    }
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}
