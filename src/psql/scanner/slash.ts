/**
 * psql backslash-command argument scanner.
 *
 * Hand-port of PostgreSQL's `src/bin/psql/psqlscanslash.l`. The upstream is a
 * flex-generated state machine with these exclusive states:
 *
 *  - `xslashcmd`        — reading the command name (the letters after `\`)
 *  - `xslashargstart`   — skipping whitespace before the next arg; `|` at
 *                         this position is special in `filepipe` mode
 *  - `xslasharg`        — reading an unquoted arg (handles `:var`,
 *                         `:'var'`, `:"var"` substitutions and the start of
 *                         `'`, `"`, `` ` `` quoted runs)
 *  - `xslashquote`      — inside `'…'` (C-string-style escapes processed)
 *  - `xslashbackquote`  — inside `` `…` `` (variable expansion only; the
 *                         body is shipped to the shell by upstream)
 *  - `xslashdquote`     — inside `"…"` (literal copy, double quotes kept)
 *  - `xslashwholeline`  — slurp rest of line, suppressing leading whitespace
 *  - `xslashend`        — terminator (we don't model it here; the caller
 *                         knows where the slash command ended)
 *
 * The TS port collapses these into a single {@link scanSlashArgs} function
 * that takes the post-command-name remainder of the input line plus a
 * {@link SlashArgMode} and returns the list of parsed arguments. We hand-roll
 * the state machine instead of attempting to mechanically translate flex
 * rules; the resulting code is easier to read and trivially testable.
 *
 * Behavioural notes vs upstream:
 *
 *  - **Whole-line mode** returns a single-element array containing the entire
 *    rest-of-line, with leading whitespace suppressed. Empty input still
 *    yields `[]` so callers can treat the result uniformly.
 *  - **filepipe mode** treats a leading `|` as the start of a shell command
 *    and slurps the rest of the line as one argument. Anything else is
 *    handled as a normal arg.
 *  - **Variable substitution** matches upstream's three forms:
 *      `:varname`       — plain expansion
 *      `:'varname'`     — SQL-literal-quoted expansion
 *      `:"varname"`     — SQL-identifier-quoted expansion
 *    `varname` is `[A-Za-z0-9_\x80-\xff]+` (upstream's `variable_char`). When
 *    the variable is unset, the colon form is emitted literally — matching
 *    the upstream `ECHO` fallback.
 *  - **no-vars mode** disables all `:var` substitution; the lexer emits the
 *    raw text. Useful for commands that should never expand variables
 *    (e.g. `\setenv`'s value argument).
 *  - **sql-id / sql-id-keep-case modes** post-process each arg through
 *    `dequoteDowncaseIdentifier`, which mirrors upstream's
 *    `dequote_downcase_identifier()`: collapse `"…"` quoting, double `""`
 *    into a single `"`, and (for `sql-id`) lowercase unquoted letters.
 *  - **Backticks** are NOT executed here. We pass through the backticked
 *    text verbatim (including the backticks) and leave the `// TODO(WP-12)`
 *    marker below. Shell execution requires `settings` and process plumbing
 *    that belong in the REPL mainloop, not the scanner.
 *  - **Inside-quote escapes** match upstream `xslashquote`: `\n \t \b \r \f`,
 *    octal `\ooo`, hex `\xhh`, and `\<other>` as a literal character. We
 *    apply them in-line so the returned arg contains the decoded value.
 */

import type { SlashArgMode } from '../types/scanner.js';

import { dequote } from './stringutils.js';

const WHITESPACE = ' \t\n\r\f\v';
const VARIABLE_CHAR_RE = /[A-Za-z0-9_\x80-\xff]/;

const isVarChar = (c: string | undefined): boolean =>
  c !== undefined && VARIABLE_CHAR_RE.test(c);

const isWhitespace = (c: string | undefined): boolean =>
  c !== undefined && WHITESPACE.includes(c);

/**
 * SQL-literal-quote a value for the `:'varname'` substitution form.
 * Mirrors libpq's `PQescapeLiteral` for the common case: wrap in `'…'`,
 * double any embedded `'`, and backslash-escape any embedded `\`. Upstream
 * additionally emits an `E` prefix when the value contains backslashes; we
 * preserve that behaviour for compatibility with code that round-trips
 * through the SQL parser.
 */
const quoteSqlLiteral = (value: string): string => {
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
const quoteSqlIdent = (value: string): string => {
  let inner = '';
  for (const c of value) {
    inner += c === '"' ? '""' : c;
  }
  return `"${inner}"`;
};

/**
 * Match upstream's `dequote_downcase_identifier()`. Strips out `"…"` quoting
 * (collapsing `""` to `"` inside quotes) and optionally downcases unquoted
 * letters. The transformation is in-place semantically: a string like
 * `FOO"BAR"BAZ` becomes `fooBARbaz` (when `downcase`) or `FOOBARBAZ`
 * (otherwise).
 */
const dequoteDowncaseIdentifier = (str: string, downcase: boolean): string => {
  let out = '';
  let inquotes = false;
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (c === '"') {
      if (inquotes && str[i + 1] === '"') {
        // Keep one quote, drop the other.
        out += '"';
        i += 2;
        continue;
      }
      inquotes = !inquotes;
      i++;
      continue;
    }
    out += downcase && !inquotes ? c.toLowerCase() : c;
    i++;
  }
  return out;
};

/**
 * Attempt to consume one of the `:var`, `:'var'`, `:"var"` variable
 * substitution forms at position `i` in `s`. Returns the new index plus the
 * substituted text, or `null` if no recognised form is present.
 *
 * Caller controls whether the colon forms are honoured at all via
 * `varLookup`: pass `undefined` to disable substitution entirely (`no-vars`
 * mode).
 */
const tryConsumeVarSubstitution = (
  s: string,
  i: number,
  varLookup: ((name: string) => string | undefined) | undefined,
): { end: number; text: string } | null => {
  if (varLookup === undefined) return null;
  if (s[i] !== ':') return null;

  // :"varname" — SQL identifier quote
  if (s[i + 1] === '"') {
    let j = i + 2;
    while (j < s.length && isVarChar(s[j])) j++;
    if (j > i + 2 && s[j] === '"') {
      const name = s.slice(i + 2, j);
      const value = varLookup(name);
      if (value === undefined) {
        // Upstream still substitutes — passing an empty string would quietly
        // misparse downstream. We instead pass through the literal so the
        // caller can see (and report) the unset reference. This matches the
        // ECHO fallback used by upstream's plain `:varname` form.
        return { end: j + 1, text: s.slice(i, j + 1) };
      }
      return { end: j + 1, text: quoteSqlIdent(value) };
    }
    return null;
  }

  // :'varname' — SQL literal quote
  if (s[i + 1] === "'") {
    let j = i + 2;
    while (j < s.length && isVarChar(s[j])) j++;
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

  // :varname — plain substitution
  if (isVarChar(s[i + 1])) {
    let j = i + 1;
    while (j < s.length && isVarChar(s[j])) j++;
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

/**
 * Process the contents of a `'…'` slash-quoted token: handle psql's C-style
 * escapes (\n, \t, \b, \r, \f, octal, hex, and \<other>) and undouble `''`.
 * The opening quote has already been consumed; we read until the matching
 * closing quote and return the decoded payload plus the new index (pointing
 * just past the closing quote).
 */
const consumeSingleQuoted = (
  s: string,
  start: number,
): { end: number; text: string } => {
  let out = '';
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      if (s[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return { end: i + 1, text: out };
    }
    if (c === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === 'n') {
        out += '\n';
        i += 2;
        continue;
      }
      if (next === 't') {
        out += '\t';
        i += 2;
        continue;
      }
      if (next === 'b') {
        out += '\b';
        i += 2;
        continue;
      }
      if (next === 'r') {
        out += '\r';
        i += 2;
        continue;
      }
      if (next === 'f') {
        out += '\f';
        i += 2;
        continue;
      }
      // Octal: \ooo (1–3 digits)
      if (next >= '0' && next <= '7') {
        const j = i + 1;
        let octEnd = j;
        while (
          octEnd < s.length &&
          octEnd - j < 3 &&
          s[octEnd] >= '0' &&
          s[octEnd] <= '7'
        ) {
          octEnd++;
        }
        const code = parseInt(s.slice(j, octEnd), 8);
        out += String.fromCharCode(code);
        i = octEnd;
        continue;
      }
      // Hex: \xhh (1–2 digits)
      if (next === 'x') {
        const j = i + 2;
        const hexRe = /[0-9a-fA-F]/;
        let hexEnd = j;
        while (hexEnd < s.length && hexEnd - j < 2 && hexRe.test(s[hexEnd])) {
          hexEnd++;
        }
        if (hexEnd > j) {
          const code = parseInt(s.slice(j, hexEnd), 16);
          out += String.fromCharCode(code);
          i = hexEnd;
          continue;
        }
      }
      // \<other> → literal next char
      out += next;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  // Unterminated — return what we have. Upstream reports an error; for the
  // scanner-as-library shape we'd rather surface the partial text and let
  // the caller decide. Tests cover both well-formed and unterminated cases.
  return { end: i, text: out };
};

/**
 * Process the contents of a `"…"` slash-quoted token. Upstream copies the
 * body verbatim *including the double quotes themselves* (see `xslashdquote`
 * rule, which ECHOes the opening dquote on entry). That preserves
 * SQL-identifier semantics — the caller's `dequoteDowncaseIdentifier()` is
 * what eventually unwraps the quotes for `sql-id` modes.
 */
const consumeDoubleQuoted = (
  s: string,
  start: number,
): { end: number; text: string } => {
  let i = start;
  while (i < s.length) {
    if (s[i] === '"') {
      return { end: i + 1, text: s.slice(start - 1, i + 1) };
    }
    i++;
  }
  // Unterminated — return what we have, including the opening quote.
  return { end: i, text: s.slice(start - 1, i) };
};

/**
 * Process the contents of a `` `…` `` slash-backquoted token. We expand
 * `:var` references inside the backticks (matching upstream's
 * `xslashbackquote` rules) but do NOT execute the resulting command — that
 * happens in the REPL mainloop where shell/settings plumbing lives.
 *
 * Returns the backticked body including the surrounding backticks so the
 * caller can see what was lexed. The `// TODO(WP-12)` marker below tracks
 * the pending shell-exec integration.
 */
const consumeBackQuoted = (
  s: string,
  start: number,
  varLookup: ((name: string) => string | undefined) | undefined,
): { end: number; text: string } => {
  // TODO(WP-12): wire backticks to shell exec. For now we lex the body,
  // expand `:var` references, and return the verbatim backticked string so
  // tests can observe the boundary. Actual subprocess execution belongs in
  // the REPL mainloop where settings and signal handlers live.
  let inner = '';
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === '`') {
      return { end: i + 1, text: '`' + inner + '`' };
    }
    const sub = tryConsumeVarSubstitution(s, i, varLookup);
    if (sub !== null) {
      inner += sub.text;
      i = sub.end;
      continue;
    }
    inner += c;
    i++;
  }
  // Unterminated — return what we have, including the opening backtick.
  return { end: i, text: '`' + inner };
};

/**
 * Lex a single slash-command argument starting at `s[i]`. Returns the parsed
 * argument text and the index just past it, or `null` if no argument is
 * available before end of input.
 */
const scanOneArg = (
  s: string,
  i: number,
  mode: SlashArgMode,
  varLookup: ((name: string) => string | undefined) | undefined,
): { end: number; arg: string } | null => {
  // Skip leading whitespace (xslashargstart).
  while (i < s.length && isWhitespace(s[i])) i++;
  if (i >= s.length) return null;

  // filepipe special: a leading `|` flips into whole-line mode for this arg.
  if (mode === 'filepipe' && s[i] === '|') {
    const rest = s.slice(i);
    return { end: s.length, arg: rest };
  }

  // Accumulate the argument piece by piece. Each iteration consumes either:
  //  - a single-quoted run
  //  - a double-quoted run
  //  - a backticked run
  //  - a :var / :'var' / :"var" substitution
  //  - a literal character (the catch-all)
  // We stop on whitespace or `\` (which begins the next slash command).
  let out = '';
  while (i < s.length) {
    const c = s[i];
    if (isWhitespace(c)) break;
    if (c === '\\') break;

    if (c === "'") {
      const r = consumeSingleQuoted(s, i + 1);
      out += r.text;
      i = r.end;
      continue;
    }
    if (c === '"') {
      const r = consumeDoubleQuoted(s, i + 1);
      out += r.text;
      i = r.end;
      continue;
    }
    if (c === '`') {
      const r = consumeBackQuoted(s, i + 1, varLookup);
      out += r.text;
      i = r.end;
      continue;
    }

    const sub = tryConsumeVarSubstitution(s, i, varLookup);
    if (sub !== null) {
      out += sub.text;
      i = sub.end;
      continue;
    }

    out += c;
    i++;
  }

  return { end: i, arg: out };
};

/**
 * Scan the argument portion of a backslash command.
 *
 * @param input     the rest of the input line *after* the command name (e.g.
 *                  `"  foo 'bar baz'"` for `\echo  foo 'bar baz'`)
 * @param mode      argument processing mode — see {@link SlashArgMode}
 * @param varLookup callback that resolves `:varname` references. Omit (or
 *                  pass `undefined`) for `no-vars` mode behaviour even when
 *                  `mode !== 'no-vars'`.
 *
 * @returns array of parsed argument strings; empty input yields `[]`.
 */
export const scanSlashArgs = (
  input: string,
  mode: SlashArgMode,
  varLookup?: (name: string) => string | undefined,
): string[] => {
  // Whole-line: return everything, with leading whitespace suppressed and a
  // single trailing newline (if any) preserved verbatim. Empty (or
  // whitespace-only) input yields no args.
  if (mode === 'whole-line') {
    let start = 0;
    while (start < input.length && isWhitespace(input[start])) start++;
    if (start >= input.length) return [];
    return [input.slice(start)];
  }

  const effectiveLookup = mode === 'no-vars' ? undefined : varLookup;
  const args: string[] = [];
  let i = 0;
  while (i < input.length) {
    const result = scanOneArg(input, i, mode, effectiveLookup);
    if (result === null) break;
    let arg = result.arg;

    // sql-id / sql-id-keep-case post-process: collapse SQL-identifier
    // quoting, optionally downcasing unquoted letters.
    if (mode === 'sql-id') {
      arg = dequoteDowncaseIdentifier(arg, true);
    } else if (mode === 'sql-id-keep-case') {
      arg = dequoteDowncaseIdentifier(arg, false);
    }

    args.push(arg);
    i = result.end;
    // Consume the inter-arg whitespace so the next iteration starts cleanly.
    while (i < input.length && isWhitespace(input[i])) i++;
    // Stop on a `\` — start of the next backslash command.
    if (input[i] === '\\') break;
  }
  return args;
};

// Re-export `dequote` for callers that want to undo `quoteIfNeeded` on
// scanned args without reaching across modules.
export { dequote };
