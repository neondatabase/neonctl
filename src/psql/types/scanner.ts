export type TokenKind =
  | 'sql'
  | 'semicolon'
  | 'backslash'
  | 'whitespace'
  | 'comment'
  | 'quoted-arg'
  | 'unquoted-arg'
  | 'eof';

export type ScannerToken = {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
};

/**
 * PROMPT2 (continuation) status. Upstream `promptStatus_t` distinguishes
 * the *reason* the parser is still waiting on input so `%R` can render a
 * mnemonic character:
 *
 *   - `'ready'`          → PROMPT1 should be drawn; we are at statement start.
 *   - `'continue'`       → plain continuation — none of the special states.
 *                          Renders `-` (the default PROMPT2 indicator).
 *   - `'continue-quote'` → inside a single-quoted string `'…`. Renders `'`.
 *   - `'continue-dquote'`→ inside a double-quoted identifier `"…`. Renders `"`.
 *   - `'continue-dollar'`→ inside a `$tag$…$tag$` dollar-quoted block.
 *                          Renders `$`.
 *   - `'paren'`          → inside unmatched `(`. Renders `(`.
 *   - `'comment'`        → inside a `/* … *\/` block comment. Renders `*`.
 *   - `'copy'`           → mainloop is forwarding raw COPY data (PROMPT3).
 *                          `%R` is suppressed by upstream in this case.
 *
 * The narrower `PlainContinuePromptStatus` alias documents the legacy
 * "anything that's not ready/paren/comment/copy" bucket; existing callers
 * comparing to the literal `'continue'` still work because every
 * `continue-*` value is structurally a continuation.
 */
export type PromptStatus =
  | 'ready'
  | 'continue'
  | 'continue-quote'
  | 'continue-dquote'
  | 'continue-dollar'
  | 'paren'
  | 'comment'
  | 'copy';

/**
 * Returns true if the scanner status represents an unterminated statement
 * waiting for more input. Useful for callers that only care whether to draw
 * PROMPT2 vs PROMPT1 and don't care about the specific reason.
 */
export const isContinueStatus = (s: PromptStatus): boolean =>
  s === 'continue' ||
  s === 'continue-quote' ||
  s === 'continue-dquote' ||
  s === 'continue-dollar' ||
  s === 'paren' ||
  s === 'comment';

export type ScanState = {
  promptStatus: PromptStatus;
  parenDepth: number;
  dollarTag: string | null;
  inLineComment: boolean;
  inBlockComment: number;
  inSingleQuote: boolean;
  inDoubleQuote: boolean;
  inEscapeString: boolean;
  /**
   * Tracks nesting of `BEGIN ... END` blocks inside the body of a
   * `CREATE [OR REPLACE] {FUNCTION|PROCEDURE}` statement. When `> 0`, a
   * top-level `;` does NOT terminate the statement — it's just the inner
   * `;` separating SQL function-body statements. Mirrors upstream
   * `psqlscan.l`'s `cur_state->begin_depth`.
   */
  beginDepth: number;
  /**
   * Lowercased first letter of each leading identifier in the current
   * statement, capped at 4 slots. Upstream `psqlscan.l` uses this to gate
   * `BEGIN ATOMIC`-style depth tracking to statements that LOOK like a
   * function body — specifically those whose leading identifier sequence
   * matches `c f`, `c p`, `c o r f`, or `c o r p` (CREATE FUNCTION /
   * PROCEDURE / OR REPLACE FUNCTION / PROCEDURE). The same gating means a
   * plain transaction `BEGIN;` does NOT enter the depth-tracked mode.
   * Reset to all-zero on every statement boundary.
   */
  identifierLetters: [string, string, string, string];
  /**
   * Count of identifiers consumed so far in the current statement (capped
   * at the length of `identifierLetters`). Drives the slot index where the
   * next leading-keyword letter is written. Mirrors upstream
   * `identifier_count`.
   */
  identifierCount: number;
};

export const initialScanState = (): ScanState => ({
  promptStatus: 'ready',
  parenDepth: 0,
  dollarTag: null,
  inLineComment: false,
  inBlockComment: 0,
  inSingleQuote: false,
  inDoubleQuote: false,
  inEscapeString: false,
  beginDepth: 0,
  identifierLetters: ['', '', '', ''],
  identifierCount: 0,
});

export type SlashArgMode =
  | 'normal'
  | 'sql-id'
  | 'sql-id-keep-case'
  | 'filepipe'
  | 'whole-line'
  | 'no-vars';
