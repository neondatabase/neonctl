import type { PsqlSettings } from './settings.js';

export type BackslashStatus = 'ok' | 'error' | 'exit' | 'reset-buf';

export type BackslashResult = {
  status: BackslashStatus;
  newBuf?: string;
  /**
   * Set to `true` by commands that have already written their own error
   * diagnostic to stderr (e.g. via `errResult` in `cmd_io.ts`, which emits
   * the upstream-shaped `psql:[<file>:<n>]:\<cmd>: <msg>` line). The
   * mainloop checks this flag when `status === 'error'` and only emits its
   * own `psql: ERROR:  <msg>` fallback line when no error has been written.
   *
   * Commands that set `lastErrorResult.message` but do NOT write their own
   * stderr line (currently only `cmd_cond`) leave this `undefined` /
   * `false`, so the mainloop still surfaces the diagnostic.
   */
  errorWritten?: boolean;
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
