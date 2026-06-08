/**
 * Port of upstream `processSQLNamePattern()` from
 * `src/fe_utils/string_utils.c`.
 *
 * psql's `\d*` commands accept shell-style name patterns of the form
 * `[db.][schema.]name`. Each component supports `*` and `?` wildcards;
 * components may be double-quoted to preserve case and treat regex
 * metacharacters literally. This routine parses the pattern into one or
 * more regex strings (one per dotted component) and emits the SQL
 * conditions that constrain the relevant catalog columns.
 *
 * The upstream entry point writes directly into a `PQExpBuffer`; we
 * return a structured {@link NamePatternResult} instead, leaving the
 * actual splicing to the caller (see `applyPattern` in `formatters.ts`).
 *
 * Differences from the C version:
 *
 *  - We don't have a `PGconn` so we can't issue `appendStringLiteralConn`
 *    or read `PQclientEncoding`. The regex strings are emitted as plain
 *    JS strings; the caller is expected to bind them via `$N` parameters
 *    to the prepared query. (Upstream inlines them as quoted SQL literals
 *    because libpq doesn't have a generic parameter-binding API for
 *    `psql`'s simple-query queries.) Binding via params is strictly
 *    safer and arguably more faithful to the *intent* of the C code.
 *  - `force_escape` is exposed as `forceLower` (Mac/Linux psql default
 *    is `force_escape = false`; we still always lowercase outside
 *    quotes because that's the documented psql user model).
 *  - The `dotcnt` output is implicit: callers can inspect
 *    `result.schemaConditions.length + result.nameConditions.length` if
 *    needed.
 *  - The `COLLATE pg_catalog.default` suffix that upstream emits for
 *    PG >= 12 is omitted; our regex parameters are bound as text and the
 *    server applies the default collation already. (If a follow-up WP
 *    discovers a real divergence we can revisit.)
 */

export type NamePatternResult = {
  /** SQL fragments AND'd into WHERE for schema constraints. */
  schemaConditions: string[];
  /** SQL fragments AND'd into WHERE for object-name constraints. */
  nameConditions: string[];
  /** Visibility check fragments emitted when no schema pattern is given. */
  visibilityConditions: string[];
  /** Values referenced by `$N` placeholders in the conditions, in order. */
  params: unknown[];
  /**
   * Number of unquoted `.` separators in the raw pattern. Independent of
   * the caller's component budget — the dispatcher inspects this to emit
   * "improper qualified name (too many dotted names)" the way upstream
   * `processSQLNamePattern` does.
   */
  dotCount: number;
  /**
   * Literal text of the *first* dotted component (lower-cased outside
   * quotes, wildcards preserved as-typed). The dispatcher compares this
   * against the connection's current database to detect cross-database
   * references. `null` for null patterns / single-component patterns
   * when the caller didn't ask to keep it (`dbnamevar` was unset).
   */
  dbLiteral: string | null;
};

export type ProcessSQLNamePatternOpts = {
  /** The user-supplied pattern, or null to skip pattern matching entirely. */
  pattern: string | null;
  /**
   * If true, regex metacharacters are quoted even outside double-quotes
   * (upstream `force_escape`). Defaults to false — psql users routinely
   * rely on regex passthrough.
   */
  forceLower?: boolean;
  /** Column expression for the schema name. Null disables schema split. */
  schemavar?: string | null;
  /** Column expression for the object name. Required. */
  namevar: string;
  /**
   * Secondary column expression that must also satisfy the name pattern
   * (e.g. `\df` matches both `proname` and an `oidvectortypes(proargtypes)`
   * call). When set, the name condition becomes `(namevar ~ ... OR altnamevar ~ ...)`.
   */
  altnamevar?: string | null;
  /**
   * Visibility check appended when the user did not supply a schema part
   * (e.g. `pg_catalog.pg_table_is_visible(c.oid)`).
   */
  visibilityrule?: string | null;
  /** Database-name column for three-part patterns (`db.schema.name`). */
  dbnamevar?: string | null;
};

type PatternParts = {
  /** Number of `.` separators in the input pattern. */
  dotCount: number;
  /** Regex strings, one per component, ordered name-first. So [name, schema?, db?]. */
  regexes: string[];
  /** Literal db name for `\l`-style matching (preserves wildcards as-is). */
  dbLiteral: string | null;
};

/**
 * Lower-case ASCII letters. Mirrors upstream's `pg_tolower` for the
 * ASCII range — we don't need full locale folding because catalog
 * identifiers are stored as-typed and case-folding only happens for
 * unquoted user input (which is restricted to lower-case anyway).
 */
const toLower = (ch: string): string =>
  ch >= 'A' && ch <= 'Z' ? String.fromCharCode(ch.charCodeAt(0) + 32) : ch;

const REGEX_SPECIALS = '|*+?()[]{}.^$\\';

/**
 * Translate a shell-style pattern into one or more regex strings, one
 * per `.`-separated component. Mirrors upstream `patternToSQLRegex()`.
 *
 * Component layout: callers requesting both schema and db split keep
 * receiving regexes for `name`, `schema`, `db` in that *reverse* order
 * (matching the upstream buffer-rotation trick). We expose the regexes
 * in name-first order; the caller maps slots to columns.
 */
const patternToSQLRegex = (
  pattern: string,
  forceLower: boolean,
  wantSchema: boolean,
  wantDb: boolean,
): PatternParts => {
  // Whenever a schema column exists, accept up to 3 dotted components
  // (`db.schema.name`) — NOT 2. Capping at 2 made `\d mydb.public.users`
  // shift: it searched schema=`mydb`, relation=`public.users` and returned
  // nothing. The 3rd (db) slot is the cross-db literal even without a
  // dbnamevar column; the dispatcher validates it against the current DB
  // (review item #23).
  const maxComponents = wantSchema || wantDb ? 3 : 1;
  const buffers: string[] = ['^('];
  let leftLiteral = '';
  // Upstream's `want_literal_dbname`: track the first component's
  // literal text unconditionally so the dispatcher can detect
  // cross-database references and emit the canonical error message.
  let trackingLeft = true;
  let inQuotes = false;
  // Total separator count, independent of `maxComponents`. Upstream
  // increments `dotcnt` past the budget so callers can raise
  // "improper qualified name (too many dotted names)".
  let dotCount = 0;

  let cp = 0;
  while (cp < pattern.length) {
    const ch = pattern[cp];
    if (ch === '"') {
      if (inQuotes && pattern[cp + 1] === '"') {
        buffers[buffers.length - 1] += '"';
        if (trackingLeft) leftLiteral += '"';
        cp += 2;
        continue;
      }
      inQuotes = !inQuotes;
      cp++;
      continue;
    }
    if (!inQuotes && ch >= 'A' && ch <= 'Z') {
      const lo = toLower(ch);
      buffers[buffers.length - 1] += lo;
      if (trackingLeft) leftLiteral += lo;
      cp++;
      continue;
    }
    if (!inQuotes && ch === '*') {
      buffers[buffers.length - 1] += '.*';
      if (trackingLeft) leftLiteral += '*';
      cp++;
      continue;
    }
    if (!inQuotes && ch === '?') {
      buffers[buffers.length - 1] += '.';
      if (trackingLeft) leftLiteral += '?';
      cp++;
      continue;
    }
    if (!inQuotes && ch === '.') {
      dotCount++;
      trackingLeft = false;
      if (buffers.length < maxComponents) {
        buffers[buffers.length - 1] += ')$';
        buffers.push('^(');
      } else {
        buffers[buffers.length - 1] += '.';
      }
      cp++;
      continue;
    }
    if (ch === '$') {
      // Always quote $ — upstream rationale: identifiers may legitimately
      // contain $ (e.g. function-language names) so the literal sense wins.
      buffers[buffers.length - 1] += '\\$';
      if (trackingLeft) leftLiteral += '$';
      cp++;
      continue;
    }
    // Ordinary data character.
    let prefix = '';
    if (inQuotes || forceLower) {
      if (REGEX_SPECIALS.includes(ch)) prefix = '\\';
    } else if (ch === '[' && pattern[cp + 1] === ']') {
      // Special: array-type bracket pair is always escaped to avoid
      // psql users hitting an empty-character-class regex error.
      prefix = '\\';
    }
    buffers[buffers.length - 1] += prefix + ch;
    if (trackingLeft) leftLiteral += ch;
    cp++;
  }
  buffers[buffers.length - 1] += ')$';

  // Upstream emits buffers in *reverse* assignment order: namebuf gets
  // the *last* component, schemabuf the second-to-last, dbnamebuf the
  // first. So we reverse for downstream consumption.
  const regexes = [...buffers].reverse();
  return {
    dotCount,
    regexes,
    // Expose the first-component literal whenever the pattern was dotted
    // (so the dispatcher can do the cross-db check) or when the caller
    // explicitly asked for it via `wantDb` (the `\l` style three-part
    // matcher).
    dbLiteral: dotCount > 0 || wantDb ? leftLiteral : null,
  };
};

/**
 * Build the SQL conditions and parameter values for a single name pattern.
 *
 * See module docstring for the contract. Pass-through pattern handling:
 * an `^(.*)$` regex is optimized away (upstream does the same), so a
 * bare `*` or empty unquoted segment emits no constraint.
 */
export const processSQLNamePattern = (
  opts: ProcessSQLNamePatternOpts,
): NamePatternResult => {
  const {
    pattern,
    forceLower = false,
    schemavar = null,
    namevar,
    altnamevar = null,
    visibilityrule = null,
    dbnamevar = null,
  } = opts;

  const result: NamePatternResult = {
    schemaConditions: [],
    nameConditions: [],
    visibilityConditions: [],
    params: [],
    dotCount: 0,
    dbLiteral: null,
  };

  if (pattern === null) {
    if (visibilityrule) {
      result.visibilityConditions.push(visibilityrule);
    }
    return result;
  }

  const parts = patternToSQLRegex(
    pattern,
    forceLower,
    schemavar !== null,
    dbnamevar !== null,
  );
  result.dotCount = parts.dotCount;
  result.dbLiteral = parts.dbLiteral;

  // parts.regexes is name-first: [nameRegex, schemaRegex?, dbRegex?]
  const nameRegex = parts.regexes[0];
  const schemaRegex = parts.regexes[1] ?? null;
  const dbRegex = parts.regexes[2] ?? null;

  // Name constraint
  if (nameRegex && nameRegex !== '^(.*)$') {
    const placeholder = `$${result.params.length + 1}`;
    if (altnamevar) {
      result.nameConditions.push(
        `(${namevar} OPERATOR(pg_catalog.~) ${placeholder} OR ${altnamevar} OPERATOR(pg_catalog.~) ${placeholder})`,
      );
    } else {
      result.nameConditions.push(
        `${namevar} OPERATOR(pg_catalog.~) ${placeholder}`,
      );
    }
    result.params.push(nameRegex);
  }

  // Schema constraint
  if (schemavar && schemaRegex && schemaRegex !== '^(.*)$') {
    const placeholder = `$${result.params.length + 1}`;
    result.schemaConditions.push(
      `${schemavar} OPERATOR(pg_catalog.~) ${placeholder}`,
    );
    result.params.push(schemaRegex);
  } else if (!schemaRegex && visibilityrule) {
    // No schema part given → use the visibility check instead.
    result.visibilityConditions.push(visibilityrule);
  }

  // Database constraint (rarely used; \l)
  if (dbnamevar && dbRegex && dbRegex !== '^(.*)$') {
    const placeholder = `$${result.params.length + 1}`;
    result.schemaConditions.push(
      `${dbnamevar} OPERATOR(pg_catalog.~) ${placeholder}`,
    );
    result.params.push(dbRegex);
  }

  return result;
};

/**
 * Apply a {@link NamePatternResult} to a SQL string emitted by
 * `queries.ts` (WP-19). The placeholder string the templates emit is
 * `true /<!---->* TODO(WP-20): pattern matching *<!---->/` (literal).
 * We substitute the conjoined conditions in its place. If no conditions
 * were produced
 * (e.g. pattern was null and no visibility rule), we leave the `true`
 * tautology so the query semantics are unchanged.
 *
 * The placeholder may appear multiple times in a single query (e.g.
 * `listCasts` matches both ends of a cast). All occurrences receive the
 * same substitution and parameter list — that mirrors upstream, which
 * threads the same pattern into both columns. Parameters get renumbered
 * to be unique across the substituted query.
 */
export const applyPattern = (
  sql: string,
  result: NamePatternResult,
  baseParams: unknown[] = [],
): { sql: string; params: unknown[] } => {
  const placeholder = 'true /* TODO(WP-20): pattern matching */';
  if (!sql.includes(placeholder)) {
    return { sql, params: baseParams };
  }
  const conditions = [
    ...result.schemaConditions,
    ...result.nameConditions,
    ...result.visibilityConditions,
  ];
  if (conditions.length === 0) {
    return { sql, params: baseParams };
  }

  // Detect occurrences. For each occurrence we need a fresh, renumbered
  // parameter slot so the same regex appears with different `$N` values.
  const occurrences = sql.split(placeholder).length - 1;
  let renumbered = sql;
  const params = [...baseParams];
  for (let occ = 0; occ < occurrences; occ++) {
    // For this occurrence, rewrite the conditions to use the next set
    // of parameter slots starting at params.length + 1.
    const slotOffset = params.length;
    const conds = conditions.map((c) =>
      c.replace(/\$(\d+)/g, (_, n: string) => `$${Number(n) + slotOffset}`),
    );
    params.push(...result.params);
    const replacement = `(${conds.join(' AND ')})`;
    // Replace just the first remaining occurrence (others stay until
    // their iteration).
    const idx = renumbered.indexOf(placeholder);
    renumbered =
      renumbered.slice(0, idx) +
      replacement +
      renumbered.slice(idx + placeholder.length);
  }
  return { sql: renumbered, params };
};
