/**
 * Filename quoting / escaping for psql backslash commands.
 *
 * psql's `\copy`, `\i`, `\o`, `\ir`, `\g`, `\edit` etc. accept a path
 * argument that follows shell-like quoting rules:
 *
 *   - Bare words may contain alphanumerics, plus a small allowlist of
 *     punctuation that does not need quoting (`-._/+@:`).
 *   - Words containing whitespace or shell metacharacters must be wrapped
 *     in single or double quotes.
 *   - Inside double quotes, backslash escapes apply to `"` and `\`.
 *   - Inside single quotes, nothing is escaped — to embed a `'`, the user
 *     must close, escape, and reopen (`'foo'\''bar'`).
 *
 * The completer uses this to decide how to render a filename candidate
 * given the partial input the user has typed. If they're already inside
 * quotes, we preserve the quote style and escape only what's needed.
 */

const NEEDS_QUOTE_RE = /[\s"'\\$`*?[\](){}<>|;&!~#]/;

/** Characters that always require quoting (whitespace or shell-special). */
export const needsQuoting = (s: string): boolean => {
  if (s.length === 0) return true;
  return NEEDS_QUOTE_RE.test(s);
};

/**
 * Wrap a filename in single quotes, escaping any embedded `'` via the
 * `'\''` trick used by POSIX shells (close, literal backslash-quote, reopen).
 */
export const singleQuote = (s: string): string =>
  `'${s.replace(/'/g, "'\\''")}'`;

/**
 * Wrap a filename in double quotes, escaping `"`, `\`, `$`, and backticks.
 */
export const doubleQuote = (s: string): string =>
  `"${s.replace(/[\\"$`]/g, (m) => `\\${m}`)}"`;

/** Detect the quoting style of the partial token the user typed. */
export type QuoteStyle = 'none' | 'single' | 'double';

export const detectQuoteStyle = (prefix: string): QuoteStyle => {
  // Walk left-to-right tracking the current quote state. A naive last-quote
  // approach gets fooled by escaped quotes inside doublequotes.
  let style: QuoteStyle = 'none';
  let i = 0;
  while (i < prefix.length) {
    const ch = prefix[i];
    if (style === 'none') {
      if (ch === "'") {
        style = 'single';
        i++;
        continue;
      }
      if (ch === '"') {
        style = 'double';
        i++;
        continue;
      }
      if (ch === '\\' && i + 1 < prefix.length) {
        // Escaped char outside quotes: skip the escape.
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (style === 'single') {
      if (ch === "'") style = 'none';
      i++;
      continue;
    }
    // double-quoted
    if (ch === '"') {
      style = 'none';
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < prefix.length) {
      i += 2;
      continue;
    }
    i++;
  }
  return style;
};

/**
 * Quote `name` so it fits as a completion of an in-progress token whose
 * current quoting state is `style`. Returns the bare suffix to append
 * (the completer is responsible for splicing it into the line).
 *
 * - `none`: pick the smallest safe quoting. Bare if safe, else single.
 * - `single`: emit the name escaped for inside single quotes; no closing
 *   quote (the user may continue typing).
 * - `double`: emit the name escaped for inside double quotes; no closing
 *   quote.
 */
export const quoteForCompletion = (name: string, style: QuoteStyle): string => {
  switch (style) {
    case 'none':
      return needsQuoting(name) ? singleQuote(name) : name;
    case 'single':
      // Inside single quotes, only `'` is special.
      return name.replace(/'/g, "'\\''");
    case 'double':
      // Inside double quotes: \, ", $, ` need escaping.
      return name.replace(/[\\"$`]/g, (m) => `\\${m}`);
  }
};

/**
 * Strip the quoting from a token to recover the raw filename. Used when
 * the caller wants to feed the partial input to a filesystem lookup.
 */
export const unquote = (s: string): string => {
  let out = '';
  let style: QuoteStyle = 'none';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (style === 'none') {
      if (ch === "'") {
        style = 'single';
        i++;
        continue;
      }
      if (ch === '"') {
        style = 'double';
        i++;
        continue;
      }
      if (ch === '\\' && i + 1 < s.length) {
        out += s[i + 1];
        i += 2;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    if (style === 'single') {
      if (ch === "'") {
        style = 'none';
        i++;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    // double-quoted
    if (ch === '"') {
      style = 'none';
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < s.length) {
      out += s[i + 1];
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
};
