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

export type PromptStatus = 'ready' | 'continue' | 'paren' | 'comment' | 'copy';

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
