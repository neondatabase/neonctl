/**
 * psql string utilities.
 *
 * TypeScript port of PostgreSQL's `src/bin/psql/stringutils.c`. Three pure
 * helpers used by the slash-command scanner and by code that constructs
 * round-trippable argument strings (notably tab-completion output).
 *
 *  - {@link strtokx}       — upstream `strtokx()`, a tokenizer with
 *                            configurable whitespace, delimiter, quote and
 *                            escape sets. Implemented as a pure function that
 *                            returns `{ token, rest }` rather than the upstream
 *                            re-entrant-via-static-variables style.
 *  - {@link quoteIfNeeded} — upstream `quote_if_needed()`. Returns the value
 *                            unchanged when it contains no characters that
 *                            require quoting; otherwise wraps in `quote`,
 *                            doubling any embedded `quote` characters.
 *  - {@link dequote}       — small companion to `quote_if_needed()`. Strips a
 *                            single surrounding `quote` and undoubles any
 *                            embedded occurrences (the inverse of the wrap
 *                            done by `quoteIfNeeded`).
 *  - {@link tryConsumeVarSubstitution} — `:NAME`/`:'NAME'`/`:"NAME"`
 *                            substitution helper used by the SQL scanner.
 *                            (The slash-arg scanner has its own local copy of
 *                            the same logic; future work can collapse them.)
 *
 * Deviations from upstream that are intentional:
 *
 *  - All inputs are JS strings, processed as UTF-16 code units. Upstream uses
 *    `PQmblenBounded()` to advance one multibyte character at a time; for the
 *    purposes of `strtokx`/`quote_if_needed`/`strip_quotes` the only thing
 *    that matters is matching ASCII delimiter / quote / escape bytes, which
 *    are guaranteed not to be the middle byte of a multibyte sequence in any
 *    PostgreSQL-supported encoding. We therefore safely walk the string one
 *    code unit at a time.
 *  - The `encoding` argument is accepted for API parity but is currently
 *    unused. The slash scanner passes it through; documenting it lets us add
 *    encoding-aware handling later without a signature break.
 *  - `strtokx` returns `{ token, rest }`. The caller iterates by passing
 *    `rest` back in; this is friendlier to TS than threading a hidden static.
 */

/**
 * Tokenizer used by the psql slash-command scanner.
 *
 * Behaviour, matching upstream `strtokx()`:
 *  1. Skip any characters in `whitespace`.
 *  2. If the cursor sits on a character in `delim`, return that single
 *     character as the token (the delimiter itself is a token).
 *  3. If the cursor sits on a quote character, scan until the matching quote.
 *     Doubled quotes are kept verbatim in the returned token (the caller can
 *     post-process by passing the result through {@link dequote}). The
 *     `escape` character, when set, lets the next character be taken
 *     literally — including a quote that would otherwise close the token.
 *  4. Otherwise scan until the next whitespace, delim, or quote character and
 *     return everything consumed.
 *
 * @param input             remaining input string
 * @param whitespace        characters treated as whitespace (any sequence is
 *                          a single separator and is consumed without
 *                          emitting a token)
 * @param delim             characters returned as standalone single-char
 *                          tokens (use `""` to disable)
 * @param quote             characters that open a quoted token (use `""` to
 *                          disable)
 * @param escape            character that lets the next char be taken
 *                          literally inside a quoted token (use `""` to
 *                          disable)
 * @param eAcceptInUnquoted optional set of "E-string" prefixes — letters that
 *                          when followed by a single quote start a quoted
 *                          token with backslash escaping enabled. Pass `"Ee"`
 *                          to mirror upstream's `e_strings = true`. `null`
 *                          disables the behaviour.
 * @param atEol             when `true`, a trailing delim character is left in
 *                          the remainder for the next call. When `false`,
 *                          trailing whitespace and any single trailing delim
 *                          are consumed before returning.
 * @param encoding          accepted for API parity; unused.
 *
 * @returns `{ token, rest }` where `token` is `null` at end of input.
 */
export const strtokx = (
  input: string,
  whitespace: string,
  delim: string,
  quote: string,
  escape: string,
  eAcceptInUnquoted: string | null,
  atEol: boolean,
  encoding?: string,
): { token: string | null; rest: string } => {
  void encoding; // documented as unused

  let i = 0;
  const n = input.length;

  // 1. Skip leading whitespace.
  while (i < n && whitespace.includes(input[i])) i++;

  if (i >= n) {
    return { token: null, rest: '' };
  }

  // 2. Single-character delim token.
  if (delim.length > 0 && delim.includes(input[i])) {
    const token = input[i];
    i++;
    if (!atEol) {
      // Consume one immediately-following separator (whitespace) so the next
      // call lands cleanly on the next real token. Upstream achieves the
      // same effect by inserting a null after the delim and advancing
      // `string` past it.
      while (i < n && whitespace.includes(input[i])) i++;
    }
    return { token, rest: input.slice(i) };
  }

  // 3. Quoted token.
  let p = i;
  let effectiveQuote = quote;
  let effectiveEscape = escape;

  // E-string prefix handling — upstream's `if (e_strings && (*p == 'E' ||
  // *p == 'e') && p[1] == '\'') { quote = "'"; escape = '\\'; p++; }`.
  if (
    eAcceptInUnquoted &&
    p + 1 < n &&
    eAcceptInUnquoted.includes(input[p]) &&
    input[p + 1] === "'"
  ) {
    effectiveQuote = "'";
    effectiveEscape = '\\';
    p++;
  }

  if (effectiveQuote.length > 0 && effectiveQuote.includes(input[p])) {
    const thisQuote = input[p];
    const start = p;
    p++; // step over opening quote
    while (p < n) {
      const c = input[p];
      if (effectiveEscape.length > 0 && c === effectiveEscape && p + 1 < n) {
        // escape + anything (except end-of-input) is a literal data char
        p += 2;
        continue;
      }
      if (c === thisQuote && input[p + 1] === thisQuote) {
        // doubled quote — keep both in the returned token; the caller can
        // dequote() if they want a clean value.
        p += 2;
        continue;
      }
      if (c === thisQuote) {
        p++; // step over closing quote
        break;
      }
      p++;
    }
    const token = input.slice(start, p);
    if (!atEol) {
      while (p < n && whitespace.includes(input[p])) p++;
    }
    return { token, rest: input.slice(p) };
  }

  // 4. Bareword: scan to next whitespace, delim, or quote.
  const start = p;
  while (p < n) {
    const c = input[p];
    if (whitespace.includes(c)) break;
    if (delim.length > 0 && delim.includes(c)) break;
    if (quote.length > 0 && quote.includes(c)) break;
    p++;
  }
  const token = input.slice(start, p);
  // Always skip trailing whitespace so the next call lands on the next
  // non-blank character. When `atEol` is `false` we additionally consume a
  // single trailing delim — the caller has told us delims are line-internal
  // separators rather than significant tokens.
  while (p < n && whitespace.includes(input[p])) p++;
  if (!atEol && p < n && delim.length > 0 && delim.includes(input[p])) {
    p++;
    while (p < n && whitespace.includes(input[p])) p++;
  }
  return { token, rest: input.slice(p) };
};

/**
 * Wrap `value` in `quote` if it contains any character in `escapeChars`,
 * `quote` itself, or is otherwise ambiguous; embedded occurrences of `quote`
 * are doubled to escape them. If no quoting is needed the original `value` is
 * returned verbatim (so this is a no-op for already-clean tokens).
 *
 * @param value       string to (possibly) quote
 * @param escapeChars characters whose presence in `value` triggers quoting
 *                    (typically the same character set passed as `whitespace`
 *                    / `delim` to {@link strtokx})
 * @param quote       quote character to wrap with (e.g. `'` or `"`)
 */
export const quoteIfNeeded = (
  value: string,
  escapeChars: string,
  quote: string,
): string => {
  if (quote.length !== 1) {
    throw new Error('quoteIfNeeded: quote must be exactly one character');
  }
  let needsQuotes = false;
  let escaped = '';
  for (const c of value) {
    if (c === quote) {
      needsQuotes = true;
      escaped += quote + quote;
    } else {
      if (escapeChars.includes(c)) needsQuotes = true;
      escaped += c;
    }
  }
  if (!needsQuotes) return value;
  return quote + escaped + quote;
};

/**
 * Inverse of {@link quoteIfNeeded}. If `value` is wrapped in `quote`, strip
 * the outer quotes and undouble any embedded `quote` occurrences. If `value`
 * is not wrapped in `quote`, it is returned unchanged.
 *
 * @param value any string (quoted or bare)
 * @param quote quote character used to wrap (e.g. `'` or `"`)
 */
export const dequote = (value: string, quote: string): string => {
  if (quote.length !== 1) {
    throw new Error('dequote: quote must be exactly one character');
  }
  if (value.length < 2 || !value.startsWith(quote) || !value.endsWith(quote)) {
    return value;
  }
  const inner = value.slice(1, -1);
  // Undouble embedded quote chars.
  let out = '';
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === quote && inner[i + 1] === quote) {
      out += quote;
      i += 2;
    } else {
      out += inner[i];
      i++;
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// :NAME variable substitution helpers.
//
// Consumed primarily by the SQL scanner (`sql.ts`). The slash-arg scanner has
// its own equivalent local copy in `slash.ts` (kept distinct because the
// slash variant doesn't need to handle the `::` SQL cast operator). When
// adding new substitution semantics, change both places.
// ---------------------------------------------------------------------------

/**
 * Callback shape consumed by the substitution helper. Mirrors upstream's
 * `psql_scan_callbacks.get_variable` — returns the variable's string value,
 * or `undefined` when the variable is unset (in which case the scanner
 * leaves the `:NAME` token verbatim to match psql's ECHO fallback).
 */
export type VarLookup = (name: string) => string | undefined;

/**
 * SQL-literal-quote a value for the `:'varname'` substitution form.
 *
 * Mirrors libpq's `PQescapeLiteral` for the common case: wrap in `'…'`,
 * double any embedded `'`, and backslash-escape any embedded `\`. Upstream
 * additionally emits an `E` prefix when the value contains backslashes; we
 * preserve that behaviour for compatibility with code that round-trips
 * through the SQL parser.
 */
export const quoteSqlLiteral = (value: string): string => {
  let needsEscape = false;
  let inner = '';
  for (const c of value) {
    if (c === "'") inner += "''";
    else if (c === '\\') {
      inner += '\\\\';
      needsEscape = true;
    } else {
      inner += c;
    }
  }
  return needsEscape ? `E'${inner}'` : `'${inner}'`;
};

/**
 * SQL-identifier-quote a value for the `:"varname"` substitution form.
 * Wraps the value in `"…"` and doubles any embedded `"`.
 */
export const quoteSqlIdent = (value: string): string => {
  let inner = '';
  for (const c of value) {
    inner += c === '"' ? '""' : c;
  }
  return `"${inner}"`;
};

// Variable-name character class. Upstream's `variable_char` flex rule matches
// `[A-Za-z0-9_\x80-\xff]+`. We do not allow a leading digit (matches
// `VarStore`'s `[A-Za-z_][A-Za-z0-9_]*` validation rule) — a token like `:1`
// is not a substitution. The high-byte range `\x80-\xff` is spelled with
// explicit `\x..` escapes so the `_` and the range stay separated; an earlier
// `[A-Za-z0-9_-ÿ]` form silently included `{`, `|`, `}`, `~` via the
// dash-range bridge between `_` (0x5F) and `ÿ` (0xFF), which broke the
// `:{?NAME}` brace-form lookup whose closing `}` would be eaten as part of
// the name.
const VAR_NAME_CONT_RE = /[A-Za-z0-9_\x80-\xff]/;
const VAR_NAME_START_RE = /[A-Za-z_\x80-\xff]/;

const isVarNameStart = (c: string | undefined): boolean =>
  c !== undefined && VAR_NAME_START_RE.test(c);

const isVarNameCont = (c: string | undefined): boolean =>
  c !== undefined && VAR_NAME_CONT_RE.test(c);

/**
 * Attempt to consume one of the `:NAME`, `:'NAME'`, `:"NAME"` variable
 * substitution forms at position `i` in `s`. Returns the new index plus the
 * substituted text, or `null` if no recognised form is present (i.e. the
 * caller should emit `s[i]` verbatim and advance one char).
 *
 * When `varLookup` is `undefined`, substitution is disabled outright (the
 * function returns `null` for every call).
 *
 * Unknown variables: upstream still ECHOes the raw `:NAME` token rather than
 * substituting an empty string, so a misspelled reference stays visible to
 * the user. We mirror that for all three forms.
 *
 * Edge cases handled here so callers don't repeat them:
 *
 *  - `::` (PostgreSQL cast operator): when `s[i+1] === ':'`, we treat the
 *    sequence as not-a-substitution and return `null`. The caller is then
 *    responsible for advancing past both colons (the SQL scanner does that
 *    in a dedicated branch before calling us).
 *  - `:` followed by a non-identifier char: returns `null`. The caller emits
 *    the literal `:` and continues.
 *  - `:'` or `:"` with no matching closing quote or empty name: returns
 *    `null`. We require at least one identifier character and a properly
 *    closed quote, matching upstream's flex rules.
 */
export const tryConsumeVarSubstitution = (
  s: string,
  i: number,
  varLookup: VarLookup | undefined,
): { end: number; text: string } | null => {
  if (varLookup === undefined) return null;
  if (s[i] !== ':') return null;
  const next = s[i + 1];
  if (next === undefined) return null;
  // `::` cast operator — never a substitution.
  if (next === ':') return null;

  // :{?NAME} — defined-variable test. Emits literal `TRUE` if the named
  // variable is set, `FALSE` otherwise. Mirrors upstream's
  // `psqlscan_test_variable` (flex rule `:\{\?{variable_char}+\}` in
  // `psqlscan.l`). Unlike the other forms we recognise here, an unset variable
  // is NOT echoed back as a literal — the whole point of `:{?NAME}` is to
  // produce a boolean regardless of definedness. A malformed brace expression
  // (missing closing `}`, empty NAME, or non-variable_char content) returns
  // `null` so the caller emits the literal `:` and continues, matching the
  // upstream flex fallback rule `:\{\?{variable_char}*`.
  if (next === '{' && s[i + 2] === '?') {
    let j = i + 3;
    while (j < s.length && isVarNameCont(s[j])) j++;
    if (j > i + 3 && s[j] === '}') {
      const name = s.slice(i + 3, j);
      const value = varLookup(name);
      return { end: j + 1, text: value !== undefined ? 'TRUE' : 'FALSE' };
    }
    return null;
  }

  // :"NAME" — SQL identifier quote
  if (next === '"') {
    let j = i + 2;
    while (j < s.length && isVarNameCont(s[j])) j++;
    if (j > i + 2 && s[j] === '"') {
      const name = s.slice(i + 2, j);
      const value = varLookup(name);
      if (value === undefined) {
        // Echo the literal `:"NAME"` for visibility.
        return { end: j + 1, text: s.slice(i, j + 1) };
      }
      return { end: j + 1, text: quoteSqlIdent(value) };
    }
    return null;
  }

  // :'NAME' — SQL literal quote
  if (next === "'") {
    let j = i + 2;
    while (j < s.length && isVarNameCont(s[j])) j++;
    if (j > i + 2 && s[j] === "'") {
      const name = s.slice(i + 2, j);
      const value = varLookup(name);
      if (value === undefined) {
        return { end: j + 1, text: s.slice(i, j + 1) };
      }
      return { end: j + 1, text: quoteSqlLiteral(value) };
    }
    return null;
  }

  // :NAME — plain substitution. We require the first char to be an
  // identifier-start char (no leading digit) to avoid eating `:1` etc.
  if (isVarNameStart(next)) {
    let j = i + 1;
    while (j < s.length && isVarNameCont(s[j])) j++;
    const name = s.slice(i + 1, j);
    const value = varLookup(name);
    if (value === undefined) {
      // Unset → emit literally so it stays visible. Upstream ECHOes the
      // entire `:name` text in this case.
      return { end: j, text: s.slice(i, j) };
    }
    return { end: j, text: value };
  }

  return null;
};
