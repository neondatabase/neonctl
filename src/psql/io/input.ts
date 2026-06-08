/**
 * Interactive line input for the psql REPL — the shared "read one line from
 * the user" primitive used by `\prompt` and `\password`.
 *
 * Models upstream psql's password / prompt reading:
 *   - `simple_prompt` (`src/port/sprompt.c`) reads a line with optional echo
 *     suppression. On a TTY it disables terminal echo for the duration of the
 *     read (we emulate this with Node's raw mode + manual character handling);
 *     when stdin is NOT a TTY it falls back to a plain line read and the
 *     `echo` flag is a no-op — the line is still consumed. We match that: a
 *     non-interactive caller piping a password in still has it read.
 *   - `\prompt` (`exec_command_prompt`) reads with echo on; `\prompt -`
 *     (no-echo password form) and `\password` read with echo suppressed.
 *
 * The terminal handling is parameterised over the input/output streams so the
 * non-TTY path (the only one testable without a real PTY) can be exercised in
 * unit tests; production callers use {@link readLine} with the process
 * defaults.
 */

import { createInterface } from 'node:readline';

/** A TTY-capable readable stream. */
type RawCapableInput = NodeJS.ReadStream;

export type ReadLineOpts = {
  /** Whether to echo typed characters. `false` requests a no-echo read. */
  echo: boolean;
  /** Input stream (default: `process.stdin`). Injectable for tests. */
  input?: NodeJS.ReadableStream;
  /** Prompt / echo output stream (default: `process.stderr`). */
  output?: NodeJS.WritableStream;
};

/** True when `stream` is a TTY whose echo we can suppress via raw mode. */
const isRawCapableTty = (
  stream: NodeJS.ReadableStream,
): stream is RawCapableInput => {
  const s = stream as RawCapableInput;
  return Boolean(s.isTTY) && typeof s.setRawMode === 'function';
};

/**
 * Read one line of input, optionally suppressing echo.
 *
 *   - `echo: false` on a TTY → put the terminal in raw mode, echo nothing,
 *     accumulate characters until Enter, then restore cooked mode. Used for
 *     password entry (`\password`, `\prompt -`).
 *   - `echo: true`, or any non-TTY input → a plain line read. On a non-TTY the
 *     `echo` flag is a no-op: we still consume and return the line, matching
 *     upstream `simple_prompt`'s behaviour with redirected stdin.
 *
 * The returned string excludes the trailing newline. EOF before any newline
 * resolves to whatever was typed so far (empty string if nothing).
 */
export const readLine = (
  prompt: string,
  opts: ReadLineOpts,
): Promise<string> => {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stderr;

  if (!opts.echo && isRawCapableTty(input)) {
    return readNoEchoTty(prompt, input, output);
  }
  return readEchoLine(prompt, input, output);
};

/** Plain, echoing (or non-TTY) line read via `node:readline`. */
const readEchoLine = (
  prompt: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string> => {
  const rl = createInterface({ input, output, terminal: false });
  return new Promise<string>((resolve) => {
    let settled = false;
    const settle = (line: string): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(line);
    };
    if (prompt.length > 0) output.write(prompt);
    // Resolve on the first complete line. Closing without one (EOF) yields ''.
    // We don't rely on `line` firing before `close`: whichever lands first
    // wins, and a buffered final line is delivered as a `line` event.
    rl.on('line', (l) => {
      settle(l);
    });
    rl.on('close', () => {
      settle('');
    });
  });
};

/**
 * No-echo read on a raw-capable TTY. Mirrors upstream `simple_prompt`'s
 * echo-off branch: switch to raw mode, gather bytes, never echo them, and
 * restore on Enter / EOF / interrupt. Backspace edits the buffer; Ctrl-C and
 * Ctrl-D abort with whatever has been typed (empty on a clean Ctrl-C).
 */
const readNoEchoTty = (
  prompt: string,
  input: RawCapableInput,
  output: NodeJS.WritableStream,
): Promise<string> => {
  return new Promise<string>((resolve) => {
    if (prompt.length > 0) output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    let buf = '';
    const finish = (result: string): void => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      // Terminate the (un-echoed) line the user couldn't see themselves type.
      output.write('\n');
      resolve(result);
    };

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r') {
          finish(buf);
          return;
        }
        if (ch === '') {
          // Ctrl-C: cancel, return nothing.
          finish('');
          return;
        }
        if (ch === '') {
          // Ctrl-D (EOF): return what we have.
          finish(buf);
          return;
        }
        if (ch === '' || ch === '\b') {
          // DEL / Backspace: drop the last character.
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };

    input.on('data', onData);
  });
};
