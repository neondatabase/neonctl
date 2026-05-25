// Minimal pg_regress-style output normalizer.
//
// Each rule is { name, pattern, replacement } and is applied in order
// against the raw psql output before diffing against the vendored
// .out file. Rules are intentionally small and explicit — the goal is
// to suppress environment noise (timestamps, container ports,
// pg-share paths, line endings, version banners) without rewriting
// semantically meaningful output.

export type NormalizeRule = {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
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
];

/**
 * Apply normalization rules to `text` in order. Pass a custom rule
 * list to override; defaults to {@link defaultRules}.
 */
export function normalize(
  text: string,
  rules: readonly NormalizeRule[] = defaultRules,
): string {
  let out = text;
  for (const rule of rules) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}
