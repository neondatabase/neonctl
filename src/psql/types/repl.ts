import type { PsqlSettings } from './settings.js';
import type { BackslashRegistry } from './backslash.js';

export type IfState =
  | 'none'
  | 'true'
  | 'false'
  | 'else-true'
  | 'else-false'
  | 'ignored';

export type CondStackFrame = {
  state: IfState;
  branchTaken: boolean;
  /**
   * Query-buffer length captured at the most recent state transition into
   * this frame:
   *
   *  - At `\if` push: the length of `queryBuf` immediately before the cond
   *    command ran (i.e. anything the surrounding scope contributed).
   *  - At `\elif` / `\else`: re-recorded to the length at that transition
   *    point, so a later truncate-on-leaving-inactive only rolls back as far
   *    as the start of the most recent branch.
   *
   * Mirrors upstream `save_query_text_state` in `mainloop.c` — the field is
   * called `query_len` on `IfStackElem`. The mainloop calls
   * `discard_query_text` (truncate back to this length) when transitioning
   * out of a branch that was INACTIVE, so SQL text accumulated by a skipped
   * branch doesn't bleed into the enclosing statement.
   */
  savedQueryBufLen: number;
};

export type CondStack = {
  push(initial: IfState, savedQueryBufLen?: number): void;
  pop(): CondStackFrame | undefined;
  top(): CondStackFrame | undefined;
  isActive(): boolean;
  setState(state: IfState): void;
  /**
   * Update the top frame's `savedQueryBufLen` — used by `\elif` / `\else`
   * to re-anchor the buffer-discard checkpoint at the start of the new
   * branch. Mirrors a second `save_query_text_state` upstream calls when
   * entering a fresh branch via the same `IfStackElem`.
   */
  setSavedQueryBufLen(len: number): void;
  depth(): number;
};

export type REPLContext = {
  settings: PsqlSettings;
  registry: BackslashRegistry;
  cond: CondStack;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export type Stdio = {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
};
