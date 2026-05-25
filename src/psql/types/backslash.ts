import type { PsqlSettings } from './settings.js';

export type BackslashStatus = 'ok' | 'error' | 'exit' | 'reset-buf';

export type BackslashResult = {
  status: BackslashStatus;
  newBuf?: string;
};

export type BackslashArgMode = 'lex' | 'raw' | 'whole-line';

export type BackslashContext = {
  settings: PsqlSettings;
  cmdName: string;
  queryBuf: string;
  rawArgs: string;
  /** Read the next lexed argument respecting psql's slash-arg lexer. */
  nextArg(mode?: import('./scanner.js').SlashArgMode): string | null;
  /** Consume the rest of the line raw (no further lex). */
  restOfLine(): string;
};

export type BackslashCmdSpec = {
  name: string;
  aliases?: string[];
  argMode?: BackslashArgMode;
  helpKey?: string;
  run(ctx: BackslashContext): Promise<BackslashResult>;
};

export type BackslashRegistry = {
  register(spec: BackslashCmdSpec): void;
  lookup(name: string): BackslashCmdSpec | undefined;
  all(): IterableIterator<BackslashCmdSpec>;
};
