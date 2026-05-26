/**
 * psql SQL scanner — statement boundary detection.
 *
 * Hand-port of PostgreSQL's `src/fe_utils/psqlscan.l`. The upstream is a
 * flex-generated state machine concerned with one thing: finding the end of a
 * SQL statement — a semicolon that is *not* inside a quote, comment, paren or
 * dollar-quoted block. Backslash commands at the top level are also detected.
 *
 * We deliberately do **not** mechanically translate the flex rules; that would
 * produce dense, untestable code. Instead we collapse the upstream exclusive
 * states into a single integer-tagged state machine inside {@link scanSql} and
 * cover behaviour with a >40-case differential corpus in `sql.test.ts`.
 *
 * Upstream exclusive states and our mapping:
 *
 *  - `<xc>`  extended C-style comment (with nested-depth tracking) → `Mode.BlockComment`
 *  - `<xq>`  standard single-quoted string                          → `Mode.SingleQuote`
 *  - `<xe>`  extended single-quoted string (`E'…'`)                 → `Mode.SingleQuote` + `escape=true`
 *  - `<xqs>` quote-stop (lookahead for continuation across newlines) → folded into the
 *            `SingleQuote` exit logic via {@link tryQuoteContinue}: after the closing
 *            `'` of a single-quoted string we look ahead through whitespace; if we
 *            find a newline followed by another `'`, we re-enter the SingleQuote
 *            state so the two pieces concatenate per SQL standard.
 *  - `<xd>`  double-quoted identifier                               → `Mode.DoubleQuote`
 *  - `<xdolq>` `$tag$…$tag$` dollar-quoted string                   → `Mode.DollarQuote`
 *  - `<xb>`, `<xh>`, `<xui>`, `<xus>` (bit / hex / unicode-quoted identifiers and strings)
 *            are folded into the standard single-/double-quoted paths because for
 *            statement-boundary purposes only the surrounding quote characters matter —
 *            no escapes inside them affect whether the closing quote is found.
 *
 * What's deliberately out of scope (with TODOs):
 *
 *  - `COPY … FROM STDIN` data-line handling. Upstream's `<xcopy>` state is
 *    **mainloop-owned, not scanner-owned**: once libpq returns `PGRES_COPY_IN`
 *    the mainloop bypasses the SQL scanner entirely and forwards raw lines to
 *    `PQputCopyData` until it sees `\.` on a line by itself. Our mainloop has
 *    that wiring stubbed as WP-16 (see `src/psql/core/mainloop.ts`, comment
 *    near the top). The scanner state machine therefore has *nothing to do*
 *    here — when the mainloop is in copy mode it never calls `scanSql` until
 *    after `\.`. The contract is: `ScanState.promptStatus = 'copy'` is set by
 *    the mainloop (not by the scanner) while copy mode is active; the scanner
 *    only consumes it for PROMPT3 selection. See {@link computePromptStatus}.
 *    No scanner API change is required for COPY support to land — only the
 *    mainloop bypass logic.
 *  - Variable substitution `:var`, `:'var'`, `:"var"`. Upstream expands these
 *    inline via callbacks; we do the same when {@link scanSql} is given a
 *    `varLookup`. Substitution fires at top-level only — never inside SQL
 *    string literals, double-quoted identifiers, dollar-quoted blocks, or
 *    comments (matches upstream's `<INITIAL>` flex rule scope). The token
 *    `::` (PostgreSQL cast operator) is preserved verbatim. When no
 *    `varLookup` is supplied (legacy call site or `\set NEW :OLD` chains
 *    that should keep the literal), no substitution happens.
 *  - Tab-completion helpers (`psqlscan_test_*`). Not needed for the REPL.
 *  - PG's `BEGIN … END` block tracking for function bodies (`begin_depth`). Upstream
 *    uses it so that `;` inside a function body doesn't terminate the surrounding
 *    `CREATE FUNCTION` statement; the modern idiom is to use dollar-quoting for
 *    function bodies (which we **do** support). Plain-string function bodies with
 *    embedded `;`s are an uncommon legacy shape — track in `// TODO(WP-04-followup)`.
 *  - U&'…' and U&"…" Unicode-escape forms — folded into the standard quoted paths;
 *    the `u&` prefix is treated as two identifier characters and the following quote
 *    starts the regular quoted run. Boundary detection is unaffected.
 *
 * Incremental API:
 *
 *  Callers thread {@link ScanState} between calls. On each call we return the first
 *  boundary in `input`. For statement terminators we hand back the SQL up to and
 *  including the `;`. For backslash commands at the top of the buffer we return
 *  the command name and the rest of the line (without consuming further input).
 *  When the chunk ends mid-statement we return `'incomplete'` (still inside a
 *  quote/comment/paren/dollar) or `'eof'` (clean break at end of buffer) with the
 *  residue and current state, and the caller is expected to read more input and
 *  call again.
 */

import type { PromptStatus, ScanState } from '../types/scanner.js';
import { initialScanState } from '../types/scanner.js';
import type { VarLookup } from './stringutils.js';
import { tryConsumeVarSubstitution } from './stringutils.js';

/**
 * All result shapes include `consumed` — the number of input code units that
 * the scanner advanced past in this call. Callers that need to slice the
 * residue (e.g. `splitStatements()`, or a REPL driving the scanner across
 * chunks) should use `consumed` rather than `sql.length`, since transformations
 * like `\;` → `;` make the two diverge.
 */
export type ScanResult =
  | { kind: 'semicolon'; sql: string; consumed: number; nextState: ScanState }
  | {
      kind: 'backslash';
      cmd: string;
      rest: string;
      consumed: number;
      nextState: ScanState;
    }
  | {
      kind: 'incomplete';
      sql: string;
      consumed: number;
      nextState: ScanState;
      promptStatus: PromptStatus;
    }
  | { kind: 'eof'; sql: string; consumed: number; nextState: ScanState };

// ---------------------------------------------------------------------------
// Character predicates.
//
// Upstream uses POSIX char classes inside flex. We mirror them as regex tests on
// the JS string. Bytes >= 0x80 are accepted in identifier positions to match
// upstream's `\200-\377` class — useful for dollar-quote tags that contain
// non-ASCII identifier characters in 8-bit encodings.
// ---------------------------------------------------------------------------

const IDENT_START_RE = /[A-Za-z_-￿]/;
const IDENT_CONT_RE = /[A-Za-z0-9_-￿]/;

const isIdentStart = (c: string | undefined): boolean =>
  c !== undefined && IDENT_START_RE.test(c);

const isIdentCont = (c: string | undefined): boolean =>
  c !== undefined && IDENT_CONT_RE.test(c);

const isWhitespaceOnly = (s: string): boolean => /^[\s]*$/.test(s);

// ---------------------------------------------------------------------------
// State cloning.
//
// `initialScanState()` returns a fresh ScanState. We treat ScanState as
// immutable from the caller's perspective — every result returns a fresh
// nextState — but mutate a local working copy inside scanSql() for speed.
// ---------------------------------------------------------------------------

const cloneState = (s: ScanState): ScanState => ({
  promptStatus: s.promptStatus,
  parenDepth: s.parenDepth,
  dollarTag: s.dollarTag,
  inLineComment: s.inLineComment,
  inBlockComment: s.inBlockComment,
  inSingleQuote: s.inSingleQuote,
  inDoubleQuote: s.inDoubleQuote,
  inEscapeString: s.inEscapeString,
});

// ---------------------------------------------------------------------------
// Dollar-quote tag matching.
//
// Upstream `{dolqdelim}` is `\$({dolq_start}{dolq_cont}*)?\$`. We replicate it:
// the tag is empty or starts with an ident-start char, then ident-cont chars,
// terminated by `$`. Returns the tag (possibly empty) and the index just past
// the closing `$`, or null if no valid delimiter is here.
// ---------------------------------------------------------------------------

type DollarMatch = { tag: string; end: number };

const matchDollarDelim = (s: string, i: number): DollarMatch | null => {
  if (s[i] !== '$') return null;
  // Empty tag: `$$`
  if (s[i + 1] === '$') return { tag: '', end: i + 2 };
  if (!isIdentStart(s[i + 1])) return null;
  let j = i + 2;
  while (j < s.length && isIdentCont(s[j])) j++;
  if (s[j] !== '$') return null;
  return { tag: s.slice(i + 1, j), end: j + 1 };
};

// ---------------------------------------------------------------------------
// Determine whether a `'` at position `i` starts an extended string (E'…').
//
// Upstream `{xestart}` is `[eE]{quote}`. We require the `E` to be at a token
// boundary so that an identifier ending in `E` (like `THREE'foo'`) doesn't
// mistakenly enable backslash escapes. Upstream's flex resolves this by
// preferring the longer identifier match; we approximate with a "previous char
// is not an identifier continuation" check.
// ---------------------------------------------------------------------------

const isExtendedStringStart = (input: string, quotePos: number): boolean => {
  if (quotePos === 0) return false;
  const prev = input[quotePos - 1];
  if (prev !== 'E' && prev !== 'e') return false;
  // Must be a standalone E — not part of a longer identifier.
  if (quotePos >= 2 && isIdentCont(input[quotePos - 2])) return false;
  return true;
};

// ---------------------------------------------------------------------------
// Skip helpers used while inside an extended single-quoted string. We need to
// recognise `\\`, `\'`, etc. so that an escaped quote does **not** close the
// string. Returns the count of characters consumed by the escape sequence (>=2
// when an escape was recognised, or 1 to advance past a non-escape backslash —
// matching upstream's `<xe>.` fallback).
// ---------------------------------------------------------------------------

const consumeXeEscape = (input: string, i: number): number => {
  // Assumes input[i] === '\\'.
  const n = input[i + 1];
  if (n === undefined) return 1; // trailing backslash at EOF — caller stays open
  if (n >= '0' && n <= '7') {
    // Octal \ooo (1..3 digits)
    let k = i + 2;
    let count = 1;
    while (
      k < input.length &&
      count < 3 &&
      input[k] >= '0' &&
      input[k] <= '7'
    ) {
      k++;
      count++;
    }
    return k - i;
  }
  if (n === 'x') {
    let k = i + 2;
    let count = 0;
    while (k < input.length && count < 2 && /[0-9a-fA-F]/.test(input[k])) {
      k++;
      count++;
    }
    return k - i; // even \x with no hex digits consumes 2 chars (matches xeunicodefail vibe)
  }
  if (n === 'u') {
    let k = i + 2;
    let count = 0;
    while (k < input.length && count < 4 && /[0-9a-fA-F]/.test(input[k])) {
      k++;
      count++;
    }
    return k - i;
  }
  if (n === 'U') {
    let k = i + 2;
    let count = 0;
    while (k < input.length && count < 8 && /[0-9a-fA-F]/.test(input[k])) {
      k++;
      count++;
    }
    return k - i;
  }
  // Any other char (including `'`, `\`, `n`, `t`, etc.) — consume both chars.
  return 2;
};

// ---------------------------------------------------------------------------
// `<xqs>` quote-continuation lookahead. SQL standard: two single-quoted
// strings separated only by whitespace that **contains at least one newline**
// concatenate into a single logical literal (`'abc'\n'def'` == `'abcdef'`).
// Whitespace without a newline is **not** a continuation — the strings stay
// separate at the lexer level (and would be a syntax error in most contexts,
// which is the parser's problem, not ours).
//
// Returns the index of the new opening `'` if a continuation is found, or
// `null` otherwise. `i` is the position just past the closing `'` of the
// previous string. We do not consume `--` line comments or `/* */` block
// comments inside the gap; upstream's flex rules treat the gap as plain
// whitespace per the lexical spec. We also avoid descending into block
// comments because that would require recursive comment-depth tracking on
// the lookahead path.
// ---------------------------------------------------------------------------

const tryQuoteContinue = (input: string, i: number): number | null => {
  let k = i;
  let sawNewline = false;
  while (k < input.length) {
    const c = input[k];
    if (c === '\n' || c === '\r') {
      sawNewline = true;
      k++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\f' || c === '\v') {
      k++;
      continue;
    }
    break;
  }
  if (!sawNewline) return null;
  if (input[k] !== "'") return null;
  return k;
};

// ---------------------------------------------------------------------------
// Recognise a `--` line comment at position `i`. Returns the index just past
// the terminating newline (or end of input). Boundary semantics: the entire
// span is part of the surrounding SQL.
// ---------------------------------------------------------------------------

const skipLineComment = (input: string, i: number): number => {
  // Assumes input[i] === '-' and input[i+1] === '-'.
  let k = i + 2;
  while (k < input.length && input[k] !== '\n' && input[k] !== '\r') k++;
  return k;
};

// ---------------------------------------------------------------------------
// Determine whether the SQL buffer accumulated so far is "empty" for the
// purpose of recognising a top-of-buffer backslash command. Upstream's
// MainLoop() only treats `\` as a slash command when the SQL query buffer is
// empty (modulo leading whitespace). We mirror that.
// ---------------------------------------------------------------------------

const isBufferEmpty = (sql: string): boolean => isWhitespaceOnly(sql);

// ---------------------------------------------------------------------------
// Compute the PROMPT2 status for an incomplete chunk. Matches upstream's
// `promptStatus_t`: the *reason* we need more input drives the `%R` rendering
// under PROMPT2 (single-quote → `'`, double-quote → `"`, dollar-quote → `$`,
// block comment → `*`, paren → `(`, otherwise → `-`).
//
// Precedence mirrors upstream `psql_scan_get_prompt`: block comment first
// (because `/*` can wrap anything else), then quoted-state checks, then
// paren depth. Plain "buffer's not empty but no special state" falls through
// to `'continue'`.
// ---------------------------------------------------------------------------

const computePromptStatus = (state: ScanState): PromptStatus => {
  if (state.inBlockComment > 0) return 'comment';
  if (state.inSingleQuote) return 'continue-quote';
  if (state.inDoubleQuote) return 'continue-dquote';
  if (state.dollarTag !== null) return 'continue-dollar';
  if (state.parenDepth > 0) return 'paren';
  return 'continue';
};

// ---------------------------------------------------------------------------
// The main scanner.
// ---------------------------------------------------------------------------

/**
 * Scan a chunk of input, returning the first significant boundary found.
 *
 * Re-callable across input chunks; thread `state` between calls.
 *
 *  - `'semicolon'`  a complete SQL statement was terminated by `;`. Caller
 *                   dispatches `sql`. State is reset for the next statement.
 *  - `'backslash'`  a backslash command at top level. Caller looks up `cmd`
 *                   and processes `rest`. `rest` is returned verbatim — the
 *                   slash-arg scanner does its own variable expansion.
 *  - `'incomplete'` input ended mid-statement; caller should read more input.
 *                   `promptStatus` indicates what PROMPT2 should render.
 *  - `'eof'`        end of input with no statement boundary AND no open
 *                   quote/comment/paren/dollar. Buffer contains `sql`.
 *
 * `varLookup` (optional): when supplied, `:NAME`, `:'NAME'` and `:"NAME"`
 * tokens at the top level are expanded inline into the `sql` accumulator.
 * Expansion is suppressed inside SQL string literals (`'…'`, `E'…'`),
 * double-quoted identifiers (`"…"`), dollar-quoted blocks (`$tag$…$tag$`),
 * and inside block / line comments — matching upstream `psqlscan.l`'s
 * `<INITIAL>`-only `{variable}` rule. `::` (PG cast) is preserved verbatim.
 * Unknown variables echo the literal `:NAME` form. Omit `varLookup` to
 * disable substitution; pre-existing call sites that pre-date the API gain
 * keep their literal-`:NAME` behaviour.
 */
export const scanSql = (
  input: string,
  state?: ScanState,
  varLookup?: VarLookup,
): ScanResult => {
  // Local working copy; we mutate freely and clone at exit.
  const st = cloneState(state ?? initialScanState());

  // SQL accumulator. We append characters as we scan; this matches upstream's
  // `output_buf` which receives all ECHOed text.
  let sql = '';
  let i = 0;

  // Convenience: emit characters from `from` (inclusive) up to `to` (exclusive)
  // into the SQL accumulator and advance the cursor.
  const emit = (from: number, to: number): void => {
    sql += input.slice(from, to);
    i = to;
  };

  while (i < input.length) {
    const c = input[i];

    // --- Inside a block comment: look for nested opens and closes. ---
    if (st.inBlockComment > 0) {
      if (c === '/' && input[i + 1] === '*') {
        st.inBlockComment++;
        sql += '/*';
        i += 2;
        continue;
      }
      if (c === '*' && input[i + 1] === '/') {
        st.inBlockComment--;
        sql += '*/';
        i += 2;
        continue;
      }
      sql += c;
      i++;
      continue;
    }

    // --- Inside a single-quoted string (standard or extended). ---
    if (st.inSingleQuote) {
      if (st.inEscapeString && c === '\\') {
        const n = consumeXeEscape(input, i);
        emit(i, i + n);
        continue;
      }
      if (c === "'") {
        // Doubled quote is a literal.
        if (input[i + 1] === "'") {
          sql += "''";
          i += 2;
          continue;
        }
        sql += "'";
        i++;
        // <xqs> quote-continuation: SQL standard merges two single-quoted
        // strings separated by whitespace containing at least one newline.
        // Look ahead; if we find one, re-enter the single-quote state at the
        // new opening `'` and keep going as if nothing happened. The gap
        // (whitespace + newline) is preserved verbatim in the SQL accumulator
        // so the round-tripped text matches the input.
        const cont = tryQuoteContinue(input, i);
        if (cont !== null) {
          sql += input.slice(i, cont + 1);
          i = cont + 1;
          // Re-derive escape-string status from the new opening `'` position;
          // each piece picks its own prefix per the lexical spec, so
          // `E'a'\n'b'` keeps escape mode off for the second piece while
          // `E'a'\nE'b'` keeps it on.
          st.inEscapeString = isExtendedStringStart(input, cont);
          continue;
        }
        st.inSingleQuote = false;
        st.inEscapeString = false;
        continue;
      }
      sql += c;
      i++;
      continue;
    }

    // --- Inside a double-quoted identifier. ---
    if (st.inDoubleQuote) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          sql += '""';
          i += 2;
          continue;
        }
        sql += '"';
        i++;
        st.inDoubleQuote = false;
        continue;
      }
      sql += c;
      i++;
      continue;
    }

    // --- Inside a dollar-quoted string. ---
    if (st.dollarTag !== null) {
      if (c === '$') {
        const m = matchDollarDelim(input, i);
        if (m !== null && m.tag === st.dollarTag) {
          sql += input.slice(i, m.end);
          i = m.end;
          st.dollarTag = null;
          continue;
        }
        // Either not a delim or a non-matching tag: consume just the $ and
        // keep scanning. This matches upstream's `<xdolq>.` fallback which
        // ECHOes the `$` and continues.
        sql += '$';
        i++;
        continue;
      }
      sql += c;
      i++;
      continue;
    }

    // --- Top-level / INITIAL state. ---

    // Block comment start.
    if (c === '/' && input[i + 1] === '*') {
      st.inBlockComment = 1;
      sql += '/*';
      i += 2;
      continue;
    }

    // Line comment.
    if (c === '-' && input[i + 1] === '-') {
      const end = skipLineComment(input, i);
      sql += input.slice(i, end);
      i = end;
      continue;
    }

    // Double-quoted identifier start (including u&"…" form which lexes as
    // `u&` + `"…"` for boundary purposes).
    if (c === '"') {
      sql += '"';
      i++;
      st.inDoubleQuote = true;
      continue;
    }

    // Single-quoted string start. Detect E'…' for escape-aware lex; bit/hex
    // (B'…', X'…') and N'…' / U&'…' need no special handling for boundary
    // detection — only the surrounding `'` matters.
    if (c === "'") {
      sql += "'";
      i++;
      st.inSingleQuote = true;
      st.inEscapeString = isExtendedStringStart(input, i - 1);
      continue;
    }

    // Dollar-quoted string start.
    if (c === '$') {
      const m = matchDollarDelim(input, i);
      if (m !== null) {
        sql += input.slice(i, m.end);
        i = m.end;
        st.dollarTag = m.tag;
        continue;
      }
      // Lone `$` (e.g. param `$1` or just bare `$`): emit and continue.
      sql += '$';
      i++;
      continue;
    }

    // Parentheses tracking.
    if (c === '(') {
      sql += '(';
      i++;
      st.parenDepth++;
      continue;
    }
    if (c === ')') {
      sql += ')';
      i++;
      if (st.parenDepth > 0) st.parenDepth--;
      continue;
    }

    // Top-level semicolon — boundary!
    if (c === ';' && st.parenDepth === 0) {
      sql += ';';
      i++;
      // Reset per-statement state. (parenDepth, dollarTag, comment depths,
      // and quote flags are already zero here by construction.)
      const next = initialScanState();
      // The post-semicolon residue stays unread; the caller passes it back in
      // on the next call. We do NOT continue scanning — upstream returns
      // immediately on LEXRES_SEMI to let the mainloop dispatch.
      // The residue *includes* anything after the `;` that the caller hasn't
      // looked at yet; we hand that back inside `sql` only if we'd consumed
      // it. Since we returned right after the `;`, sql ends in `;`.
      return {
        kind: 'semicolon',
        sql,
        consumed: i,
        nextState: next,
      };
    }

    // Backslash — only at top of buffer is a slash command.
    if (c === '\\') {
      // Upstream special: `\;` and `\:` are forced into the query buffer (so a
      // user can write `SELECT 1\;` to suppress immediate dispatch). We honour
      // those by emitting just the second char and not breaking.
      const nxt = input[i + 1];
      if (nxt === ';' || nxt === ':') {
        sql += nxt;
        i += 2;
        continue;
      }
      if (isBufferEmpty(sql)) {
        // True backslash command. Lex `\cmd` followed by the rest of the line.
        // The slash arg lexer (WP-05) handles arg splitting; we only need to
        // peel off the command name and hand the remainder over.
        i++; // consume the `\`
        // Command name: contiguous non-whitespace, non-`\` chars. Upstream
        // also breaks on `;` here? No — see the `xslashcmd` state: it accepts
        // ASCII letters + a few specials. We match alnum + a small set of
        // standalone-cmd punctuation (`?`, `!`, `+`, etc.) which covers
        // `\?`, `\!`, `\d+`, etc.
        let cmdEnd = i;
        // Allow a single non-alnum punctuation char like `?` or `!` to be the
        // whole command name (matches `\?` and `\!`). Otherwise accept any
        // run of identifier chars + `+` (which is the trailing modifier on
        // `\d+`, `\dt+` etc.).
        const first = input[i];
        if (first !== undefined && /[A-Za-z]/.test(first)) {
          // Backslash command names are ASCII alnum + `_` + `+` (the trailing
          // modifier on `\d+`/`\dt+`). Underscore is required for psql's
          // multi-word commands: `\lo_import`, `\lo_export`, `\lo_list`,
          // `\lo_unlink`, `\bind_named`, `\close_prepared`.
          while (cmdEnd < input.length && /[A-Za-z0-9_+]/.test(input[cmdEnd])) {
            cmdEnd++;
          }
        } else if (first !== undefined && /[?!|]/.test(first)) {
          cmdEnd = i + 1;
        } else {
          // Empty or strange char: treat as a zero-length command and let the
          // dispatcher report "unknown command".
          cmdEnd = i;
        }
        const cmd = input.slice(i, cmdEnd);
        // Rest of the line — everything up to a newline. Newlines terminate
        // slash commands. The slash arg lexer (WP-05) parses the argument
        // syntax; we just slice.
        let restEnd = cmdEnd;
        while (
          restEnd < input.length &&
          input[restEnd] !== '\n' &&
          input[restEnd] !== '\r'
        ) {
          restEnd++;
        }
        const rest = input.slice(cmdEnd, restEnd);
        // Note: we *don't* consume the newline; it's left for the next chunk
        // so caller can see PROMPT1 reset cleanly.
        return {
          kind: 'backslash',
          cmd,
          rest,
          consumed: restEnd,
          nextState: cloneState(st),
        };
      }
      // Buffered SQL present: the `\` is part of the SQL (e.g. inside a
      // string we wouldn't reach here, but at top level with text in the
      // buffer it's likely a typo — upstream just ECHOes it).
      sql += '\\';
      i++;
      continue;
    }

    // Variable substitution (`:NAME`, `:'NAME'`, `:"NAME"`). Only fires at
    // top level — not inside strings / dollar-quoted blocks / identifiers /
    // comments, all of which are handled above this point.
    //
    // `::` (PostgreSQL cast operator): emit BOTH colons as a single unit so
    // the second `:` doesn't get re-examined on the next iteration and
    // wrongly interpreted as the start of a `:NAME` substitution. This is
    // load-bearing for `'foo'::int`-style casts and matches upstream
    // `psqlscan.l`, which absorbs the `::` via its `{op_chars}+` operator
    // rule before the `:{variable}` rule can fire. We do not need to gate
    // this on `varLookup` — without substitution the result is byte-
    // identical to the catch-all path.
    if (c === ':' && input[i + 1] === ':') {
      sql += '::';
      i += 2;
      continue;
    }
    if (c === ':') {
      const sub = tryConsumeVarSubstitution(input, i, varLookup);
      if (sub !== null) {
        sql += sub.text;
        i = sub.end;
        continue;
      }
    }

    // Anything else: just emit. This is the catch-all matching upstream's
    // `{self}`, `{operator}`, `{identifier}`, `{numeric}`, `{other}` rules —
    // none of which can change scanner state at the top level.
    sql += c;
    i++;
  }

  // --- End of input. ---
  //
  // Decide between 'incomplete' (still inside something) and 'eof' (clean
  // break, but no semicolon was found in this chunk).
  const hasOpenContext =
    st.inBlockComment > 0 ||
    st.inSingleQuote ||
    st.inDoubleQuote ||
    st.dollarTag !== null ||
    st.parenDepth > 0;

  if (hasOpenContext) {
    const promptStatus = computePromptStatus(st);
    st.promptStatus = promptStatus;
    return {
      kind: 'incomplete',
      sql,
      consumed: i,
      nextState: cloneState(st),
      promptStatus,
    };
  }

  // COPY-data handling is a mainloop concern, not a scanner concern.
  // After a `COPY ... FROM STDIN` statement libpq returns PGRES_COPY_IN; the
  // mainloop bypasses the scanner and forwards raw lines until `\.`. See the
  // file header for the contract.
  return {
    kind: 'eof',
    sql,
    consumed: i,
    nextState: cloneState(st),
  };
};

/**
 * Split a complete script into statement boundaries.
 *
 * Convenience wrapper for non-streaming inputs (e.g. `-c "SELECT 1; SELECT 2;"`,
 * or whole-file `-f` runs). Returns one string per terminated statement, plus
 * a trailing un-terminated residue iff non-empty (matching psql's behaviour:
 * input that ends without `;` is still dispatched on EOF for `-c`/`-f`).
 *
 * Backslash commands appear in the result as `\cmd rest…` strings so the caller
 * can dispatch them uniformly; this matches `psql -f script.sql` which mixes
 * SQL and backslash commands in a single stream.
 *
 * The optional `varLookup` is forwarded to {@link scanSql} so callers that
 * want variable expansion in `-c`/`-f` input get it. NOTE: the consumed-slice
 * round-trip property (sum of returned strings === `input`) is preserved
 * **only** when `varLookup` is omitted; substitution legitimately changes
 * the byte content of each returned statement.
 */
export const splitStatements = (
  input: string,
  varLookup?: VarLookup,
): string[] => {
  const out: string[] = [];
  let remaining = input;
  let state: ScanState = initialScanState();

  // Cap iterations defensively; any non-progressing scan would be a bug.
  let safety = 0;
  while (remaining.length > 0) {
    if (++safety > input.length + 10) break;
    const r = scanSql(remaining, state, varLookup);
    if (r.kind === 'semicolon') {
      // When the caller requested variable substitution, the scanner has
      // already applied it to `r.sql` — we must push the transformed text,
      // not the raw input slice. Without substitution the slice and `r.sql`
      // are identical except for `\;`-style backslash transforms; for the
      // round-trip property we keep pushing the consumed slice in that case.
      out.push(varLookup ? r.sql : remaining.slice(0, r.consumed));
      remaining = remaining.slice(r.consumed);
      state = r.nextState;
      continue;
    }
    if (r.kind === 'backslash') {
      // Emit the consumed input slice verbatim (covers any leading whitespace
      // that scanSql skipped over before the `\`, plus `\cmd rest`). The
      // slash-arg scanner will do its own variable expansion when the
      // command body is parsed — we don't preprocess it here.
      out.push(remaining.slice(0, r.consumed));
      remaining = remaining.slice(r.consumed);
      state = r.nextState;
      continue;
    }
    if (r.kind === 'eof' || r.kind === 'incomplete') {
      // No more boundaries in this input. Append residue if non-empty.
      // Same as the semicolon branch: emit `r.sql` (with substitutions
      // applied) when `varLookup` is set, otherwise pass the raw slice
      // through for byte-identical round-tripping.
      if (remaining.length > 0) {
        out.push(varLookup ? r.sql : remaining);
      }
      remaining = '';
      break;
    }
  }
  return out;
};
