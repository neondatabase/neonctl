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
});

export type SlashArgMode =
  | 'normal'
  | 'sql-id'
  | 'sql-id-keep-case'
  | 'filepipe'
  | 'whole-line'
  | 'no-vars';
