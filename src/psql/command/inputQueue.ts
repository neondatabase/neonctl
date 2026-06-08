/**
 * Pending-input queue for `\i` / `\include`.
 *
 * psql's `process_file()` switches the input source for the duration of an
 * included file: while a file is being processed, every subsequent input
 * line comes from the file, not the terminal. The natural place for that
 * switch is the mainloop (`MainLoop` in upstream `mainloop.c`).
 *
 * For WP-15 we keep `src/psql/core/mainloop.ts` untouched. Instead we expose
 * a tiny module-local queue. `\i` enqueues the contents of the included
 * file via {@link enqueue}; a future WP modifies the mainloop's line-source
 * to drain from {@link consumeNext} before reading more user input.
 *
 * Behaviour:
 *
 *  - The queue stores file contents as raw strings (typically containing
 *    multiple newline-separated SQL statements). Order is FIFO.
 *  - {@link consumeNext} returns the head, or `null` if the queue is empty.
 *  - {@link reset} clears the queue (used by tests and by any future error
 *    recovery path that wants to abandon pending input).
 *
 * The queue is module-scoped because it represents the include stack of a
 * single REPL. Tests should always call {@link reset} in their afterEach so
 * a leftover entry doesn't contaminate the next test.
 */

const pending: string[] = [];

/** Append a string of input to the back of the queue. */
export const enqueue = (content: string): void => {
  pending.push(content);
};

/** Return and remove the next pending input, or `null` if none. */
export const consumeNext = (): string | null => {
  if (pending.length === 0) return null;
  return pending.shift() ?? null;
};

/** Number of items currently in the queue. */
export const size = (): number => pending.length;

/** Empty the queue. Tests should call this in cleanup. */
export const reset = (): void => {
  pending.length = 0;
};
