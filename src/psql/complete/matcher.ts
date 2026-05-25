/**
 * Matches / TailMatches / HeadMatches DSL.
 *
 * TypeScript port of the pattern-matching helpers in psql's tab-complete.in.c.
 * The C source uses a varargs macro layered on top of `word_matches()` to
 * decide whether a sequence of "previous words" matches a pattern. We
 * reproduce the same shape with plain functions because (a) JS has no
 * preprocessor macros and (b) array spread is the natural varargs analogue.
 *
 *   Matches('SELECT', MatchAny, 'FROM')       — exact word-count match.
 *   TailMatches('SELECT', MatchAny, 'FROM')   — match the last N words.
 *   HeadMatches('ALTER', 'TABLE')             — match the first N words.
 *
 * Wildcards and special tokens (mirroring the upstream constants):
 *
 *   MatchAny             — any single word (`NULL` upstream).
 *   MatchAnyExcept(x)    — any word that doesn't match `x` (upstream `"!x"`).
 *   '*' inside a pattern — wildcard within a single word (e.g. `'pg_*'`).
 *   '|' inside a pattern — alternation (e.g. `'TABLE|VIEW'`).
 *
 * Comparisons are case-insensitive by default (SQL keywords); pass
 * `caseSensitive: true` to the DSL helpers when matching strictly.
 *
 * The tokenizer is exported separately because the `index.ts` entry point
 * needs to do the same word-split-then-match dance.
 */

export const MatchAny = null as unknown as string;

export const MatchAnyExcept = (pattern: string): string => '!' + pattern;

const cimatch = (
  s1: string,
  s2: string,
  n: number,
  caseSensitive: boolean,
): boolean => {
  if (s1.length < n || s2.length < n) return false;
  const a = s1.slice(0, n);
  const b = s2.slice(0, n);
  if (caseSensitive) return a === b;
  return a.toLowerCase() === b.toLowerCase();
};

/**
 * Return true iff `word` matches `pattern`. `null`/`MatchAny` matches
 * everything. A leading `!` inverts the match. `|` separates alternatives.
 * `*` is a single-word wildcard.
 */
export const wordMatches = (
  pattern: string | null,
  word: string,
  caseSensitive = false,
): boolean => {
  if (pattern === null) return true;
  if (pattern.startsWith('!')) {
    return !wordMatches(pattern.slice(1), word, caseSensitive);
  }
  const wordlen = word.length;
  let cursor = pattern;
  for (;;) {
    let starIdx = -1;
    let i = 0;
    while (i < cursor.length && cursor[i] !== '|') {
      if (cursor[i] === '*') starIdx = i;
      i++;
    }
    if (starIdx >= 0) {
      const beforeLen = starIdx;
      const afterLen = i - starIdx - 1;
      if (
        wordlen >= beforeLen + afterLen &&
        cimatch(word, cursor, beforeLen, caseSensitive) &&
        cimatch(
          word.slice(wordlen - afterLen),
          cursor.slice(starIdx + 1),
          afterLen,
          caseSensitive,
        )
      ) {
        return true;
      }
    } else {
      if (wordlen === i && cimatch(word, cursor, wordlen, caseSensitive)) {
        return true;
      }
    }
    if (i >= cursor.length) break;
    cursor = cursor.slice(i + 1);
  }
  return false;
};

/**
 * Exact-length match: every word in `words` must match the corresponding
 * pattern. `words` here is "previous words" — i.e. the words BEFORE the
 * current (in-progress) word.
 *
 * The upstream uses `previous_words_count + 1 == narg` because the C array
 * includes both prev words AND the current. Our representation only stores
 * prev words; the caller passes the in-progress word separately.
 *
 *   prev = ['SELECT'], pattern = ['SELECT']         → true   (1 == 1)
 *   prev = ['SELECT', 'a'], pattern = ['SELECT']    → false  (2 != 1)
 */
export const Matches = (
  prev: readonly string[],
  patterns: readonly (string | null)[],
  caseSensitive = false,
): boolean => {
  if (prev.length !== patterns.length) return false;
  for (let k = 0; k < patterns.length; k++) {
    if (!wordMatches(patterns[k], prev[k], caseSensitive)) return false;
  }
  return true;
};

/**
 * Tail match: the LAST N words of `prev` must match the patterns.
 *
 *   prev = ['SELECT', 'a', 'FROM'], patterns = ['FROM']   → true
 *   prev = ['SELECT'], patterns = ['SELECT', 'FROM']     → false (too few)
 */
export const TailMatches = (
  prev: readonly string[],
  patterns: readonly (string | null)[],
  caseSensitive = false,
): boolean => {
  if (prev.length < patterns.length) return false;
  const offset = prev.length - patterns.length;
  for (let k = 0; k < patterns.length; k++) {
    if (!wordMatches(patterns[k], prev[offset + k], caseSensitive))
      return false;
  }
  return true;
};

/**
 * Head match: the FIRST N words of `prev` must match.
 *
 *   prev = ['ALTER', 'TABLE', 'foo'], patterns = ['ALTER', 'TABLE']  → true
 */
export const HeadMatches = (
  prev: readonly string[],
  patterns: readonly (string | null)[],
  caseSensitive = false,
): boolean => {
  if (prev.length < patterns.length) return false;
  for (let k = 0; k < patterns.length; k++) {
    if (!wordMatches(patterns[k], prev[k], caseSensitive)) return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Tokenizer.
// ---------------------------------------------------------------------------

export type Token = {
  /** Display form of the word (quote-stripped). */
  text: string;
  /** Byte offset in the source string where the token starts. */
  start: number;
  /** Byte offset (exclusive) where it ends. */
  end: number;
  /** Original literal form including any quote characters. */
  raw: string;
};

/**
 * Split `input` into psql-style words for completion purposes.
 *
 *   - Whitespace is the basic separator.
 *   - "..."           treated as ONE word (quoted identifier).
 *   - '...'           treated as ONE word (string literal).
 *   - \backslash...   treated as ONE word (the backslash command).
 *   - Punctuation (commas, parens, semicolons) is broken into its own word.
 *   - Embedded `.` (schema-qualifier) keeps the dotted name as a single word
 *     so completion sees `pg_catalog.pg_class` whole.
 *
 * The tokenizer is intentionally pragmatic — it doesn't validate SQL, it
 * just slices well enough for the rule body to inspect previous words.
 */
export const tokenize = (input: string): Token[] => {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];

    // Whitespace.
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    // Backslash command. Capture the entire backslash word as one token.
    if (ch === '\\') {
      const start = i;
      i++;
      // Single-char commands like `\!` and `\?` are valid; otherwise read
      // letters until we hit whitespace or punctuation.
      if (i < input.length && /[!?]/.test(input[i])) {
        i++;
      } else {
        while (i < input.length && /[A-Za-z_]/.test(input[i])) i++;
      }
      out.push({
        text: input.slice(start, i),
        raw: input.slice(start, i),
        start,
        end: i,
      });
      continue;
    }

    // Double-quoted identifier.
    if (ch === '"') {
      const start = i;
      i++;
      while (i < input.length) {
        if (input[i] === '"') {
          // "" inside quotes is an escaped quote.
          if (input[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out.push({
        text: input.slice(start, i),
        raw: input.slice(start, i),
        start,
        end: i,
      });
      continue;
    }

    // Single-quoted string literal.
    if (ch === "'") {
      const start = i;
      i++;
      while (i < input.length) {
        if (input[i] === '\\' && i + 1 < input.length) {
          i += 2;
          continue;
        }
        if (input[i] === "'") {
          if (input[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out.push({
        text: input.slice(start, i),
        raw: input.slice(start, i),
        start,
        end: i,
      });
      continue;
    }

    // Punctuation that splits words.
    if (
      ch === ',' ||
      ch === ';' ||
      ch === '(' ||
      ch === ')' ||
      ch === '[' ||
      ch === ']'
    ) {
      out.push({ text: ch, raw: ch, start: i, end: i + 1 });
      i++;
      continue;
    }

    // Bareword: letters, digits, underscore, `.` (schema qualifier), `:` (var
    // expansion marker is kept inside the word), `$` (positional param).
    const start = i;
    while (i < input.length) {
      const c = input[i];
      if (
        c === ' ' ||
        c === '\t' ||
        c === '\n' ||
        c === '\r' ||
        c === ',' ||
        c === ';' ||
        c === '(' ||
        c === ')' ||
        c === '[' ||
        c === ']' ||
        c === '"' ||
        c === "'" ||
        c === '\\'
      ) {
        break;
      }
      i++;
    }
    out.push({
      text: input.slice(start, i),
      raw: input.slice(start, i),
      start,
      end: i,
    });
  }
  return out;
};

/**
 * Slice `input` at `cursor`, then determine what's being completed:
 *
 *   - `prevWords`: the completed words ENTIRELY before the cursor.
 *   - `currentWord`: the partial word the cursor is sitting in (may be '').
 *   - `replaceLength`: number of code points to chop off the input before
 *      inserting the completion (= length of currentWord in code points).
 *
 * The tokenizer is run on `input.slice(0, cursor)` and the LAST token, if
 * it ends exactly at cursor and didn't start with whitespace/punctuation,
 * becomes the current word. Otherwise the current word is empty (the user
 * just typed a space and is starting a new word).
 */
export const splitForCompletion = (
  input: string,
  cursor: number,
): { prevWords: string[]; currentWord: string; replaceLength: number } => {
  const head = input.slice(0, cursor);
  const tokens = tokenize(head);
  if (tokens.length === 0) {
    return { prevWords: [], currentWord: '', replaceLength: 0 };
  }
  const last = tokens[tokens.length - 1];

  // The cursor is sitting inside the last token if (a) it ends exactly at
  // cursor AND (b) the last char before cursor isn't whitespace.
  const charBefore = head[head.length - 1];
  const inWhitespace =
    charBefore === ' ' ||
    charBefore === '\t' ||
    charBefore === '\n' ||
    charBefore === '\r';
  if (last.end === head.length && !inWhitespace) {
    return {
      prevWords: tokens.slice(0, -1).map((t) => t.text),
      currentWord: last.text,
      replaceLength: Array.from(last.text).length,
    };
  }
  return {
    prevWords: tokens.map((t) => t.text),
    currentWord: '',
    replaceLength: 0,
  };
};
