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
 *            `SingleQuote` exit logic; we only honour continuation across the *same* chunk
 *  - `<xd>`  double-quoted identifier                               → `Mode.DoubleQuote`
 *  - `<xdolq>` `$tag$…$tag$` dollar-quoted string                   → `Mode.DollarQuote`
 *  - `<xb>`, `<xh>`, `<xui>`, `<xus>` (bit / hex / unicode-quoted identifiers and strings)
 *            are folded into the standard single-/double-quoted paths because for
 *            statement-boundary purposes only the surrounding quote characters matter —
 *            no escapes inside them affect whether the closing quote is found.
 *  - The `<xqs>` `quotecontinue` lookahead (newline-separated string concatenation:
 *            `'foo'\n'bar'`) is **not** implemented in this WP. Two separate quoted
 *            strings will be lexed as two strings, which is correct for boundary
 *            detection — the in-between whitespace does not contain a semicolon.
 *
 * What's deliberately out of scope (with TODOs):
 *
 *  - `COPY … FROM STDIN` data-line handling. Upstream enters a special copy-data state
 *    in which `\.` on its own line ends the data block. The mainloop owns that;
 *    we'd just feed the data straight through. See `// TODO(WP-16)` below.
 *  - Variable substitution `:var`, `:'var'`, `:"var"`. Upstream expands these inline
 *    via callbacks; we leave the colon-prefixed text in place and let the REPL
 *    expand on the assembled SQL string. The boundary detector doesn't need it.
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

const IDENT_START_RE = /[A-Za-z_-￿]/;
const IDENT_CONT_RE = /[A-Za-z0-9_-￿]/;

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
// Compute the PROMPT2 status for an incomplete chunk. We map the upstream
// finer-grained `promptStatus_t` (which distinguishes single-quote,
// double-quote, dollar-quote and comment) down to the four-value enum exposed
// by `ScanState.promptStatus`:
//
//   - `'comment'` when inside a /* … */ comment
//   - `'paren'`  when inside unmatched parens (and no other state takes precedence)
//   - `'continue'` otherwise (covers quote/dquote/dollar and "just need more lines")
//
// TODO(WP-04-followup): expose the finer-grained status so PROMPT2 can render
// `'`, `"`, `$`, `*` etc. directly. The infrastructure is here (the boolean
// state fields tell us exactly which kind of incomplete we have); only the
// PromptStatus enum needs widening, which is a WP-00 type change.
// ---------------------------------------------------------------------------

const computePromptStatus = (state: ScanState): PromptStatus => {
  if (state.inBlockComment > 0) return 'comment';
  if (state.inSingleQuote || state.inDoubleQuote || state.dollarTag !== null) {
    return 'continue';
  }
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
 *                   and processes `rest`.
 *  - `'incomplete'` input ended mid-statement; caller should read more input.
 *                   `promptStatus` indicates what PROMPT2 should render.
 *  - `'eof'`        end of input with no statement boundary AND no open
 *                   quote/comment/paren/dollar. Buffer contains `sql`.
 */
export const scanSql = (input: string, state?: ScanState): ScanResult => {
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

  // TODO(WP-16): if the most recently dispatched statement was a `COPY …
  // FROM STDIN`, the mainloop will set promptStatus = 'copy' and feed raw
  // lines through until `\.`. We don't model that here; it's a higher-level
  // concern.
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
 */
export const splitStatements = (input: string): string[] => {
  const out: string[] = [];
  let remaining = input;
  let state: ScanState = initialScanState();

  // Cap iterations defensively; any non-progressing scan would be a bug.
  let safety = 0;
  while (remaining.length > 0) {
    if (++safety > input.length + 10) break;
    const r = scanSql(remaining, state);
    if (r.kind === 'semicolon') {
      // For a clean round-trip we push the original slice the scanner consumed,
      // not `r.sql` — they can differ when the scanner applies in-place
      // transformations (notably `\;` → `;`).
      out.push(remaining.slice(0, r.consumed));
      remaining = remaining.slice(r.consumed);
      state = r.nextState;
      continue;
    }
    if (r.kind === 'backslash') {
      // Emit the consumed input slice verbatim (covers any leading whitespace
      // that scanSql skipped over before the `\`, plus `\cmd rest`).
      out.push(remaining.slice(0, r.consumed));
      remaining = remaining.slice(r.consumed);
      state = r.nextState;
      continue;
    }
    if (r.kind === 'eof' || r.kind === 'incomplete') {
      // No more boundaries in this input. Append residue if non-empty.
      if (remaining.length > 0) out.push(remaining);
      remaining = '';
      break;
    }
  }
  return out;
};
