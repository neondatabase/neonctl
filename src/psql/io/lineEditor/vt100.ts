/**
 * VT100/xterm input decoder and CSI escape helpers.
 *
 * Input side: a streaming decoder that consumes raw bytes from stdin and
 * emits `KeyEvent`s. Handles:
 *
 *   - Printable ASCII (0x20..0x7e)
 *   - Control bytes (0x00..0x1f, plus 0x7f → backspace)
 *   - CSI sequences (`\x1b[...`): arrow keys, Home/End, Delete, PageUp/Dn,
 *     bracketed paste markers
 *   - SS3 sequences (`\x1bO<x>`) for application-mode arrows
 *   - Alt-X sequences (`\x1b<letter>`) for Meta keystrokes
 *   - Multi-byte UTF-8 codepoints (accumulated until complete)
 *
 * Output side: small helpers wrapping CSI escapes used by the renderer.
 *
 * The decoder is allocation-light: input chunks are appended to a private
 * buffer, then drained from the head. We never throw on malformed input —
 * leftover bytes that can't be decoded become a single `KeyEvent` with
 * `key: 'unknown'` so the editor can ring the bell instead of dying.
 */

/** Logical key categories the editor cares about. */
export type KeyName =
  | 'char' // printable, see `char` field
  | 'enter' // CR or LF
  | 'tab'
  | 'backspace'
  | 'delete'
  | 'escape'
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  | 'paste-start'
  | 'paste-end'
  | 'unknown';

export type KeyEvent = {
  key: KeyName;
  /** For `key: 'char'` (printable or control char). */
  char?: string;
  /** Control modifier: set for `^A`..`^_` and DEL. */
  ctrl?: boolean;
  /** Meta/Alt modifier: set for `Esc-<key>` and `\x1b[1;3X` style sequences. */
  meta?: boolean;
  /** Raw bytes that produced this event (for paste passthrough debugging). */
  raw?: Uint8Array;
};

/** Convenience: build a control-character event for byte `b` in 0x01..0x1f. */
const controlEvent = (b: number): KeyEvent => {
  // ^A == 0x01 maps back to 'a'. Lowercase keeps things consistent.
  const letter = String.fromCharCode(b + 0x60);
  return { key: 'char', char: letter, ctrl: true };
};

export type Vt100DecoderOptions = {
  /**
   * Bare-Escape timeout in milliseconds. When a single `Esc` byte sits at the
   * head of the pending buffer with no follow-on byte, the decoder waits up
   * to this long before emitting a bare `escape` event. Set to `0` to
   * disable (Esc is emitted immediately, matching the pre-WP-24-polish
   * behaviour). Default: 0 (off; the editor wrapper can override).
   *
   * Real-world Alt-X sequences (`Esc` + `<letter>`) arrive as two bytes in
   * the same read on every modern terminal, so a small grace period (~30ms)
   * is enough to disambiguate without making the user wait.
   */
  escTimeoutMs?: number;
  /**
   * Called when the bare-Esc timer fires with a synthetic key event. The
   * caller is expected to push the event into its own queue, since `push()`
   * has long returned by the time the timer runs.
   */
  onTimeoutEvent?: (ev: KeyEvent) => void;
};

/** Streaming decoder. Owns a small pending-byte buffer. */
export class Vt100Decoder {
  private pending: number[] = [];
  /** UTF-8 continuation accumulator. */
  private utf8Bytes: number[] = [];
  private utf8Expect = 0;
  /** Esc-disambiguation timeout in ms; 0 disables. */
  private readonly escTimeoutMs: number;
  /** Callback for timer-driven events. */
  private readonly onTimeoutEvent?: (ev: KeyEvent) => void;
  /** Active bare-Esc timer, if one is pending. */
  private escTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while we're sitting on a buffered Esc waiting for follow-on. */
  private escPending = false;

  constructor(opts: Vt100DecoderOptions = {}) {
    this.escTimeoutMs = opts.escTimeoutMs ?? 0;
    this.onTimeoutEvent = opts.onTimeoutEvent;
  }

  /** Reset internal state. Useful before re-entering raw mode after a fork. */
  reset(): void {
    this.pending.length = 0;
    this.utf8Bytes.length = 0;
    this.utf8Expect = 0;
    this.clearEscTimer();
    this.escPending = false;
  }

  private clearEscTimer(): void {
    if (this.escTimer !== null) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
  }

  /**
   * Feed a chunk of input. Returns zero or more `KeyEvent`s; bytes that
   * form an incomplete sequence are buffered until the next call.
   */
  push(chunk: Uint8Array): KeyEvent[] {
    // A follow-on byte arrived: cancel any pending Esc timer; the standard
    // sequence consumption path will see the Esc + byte together.
    if (chunk.length > 0 && this.escPending) {
      this.clearEscTimer();
      this.escPending = false;
    }
    for (const b of chunk) this.pending.push(b);
    const out: KeyEvent[] = [];
    // Drain as long as we can make progress.
    for (;;) {
      const before = this.pending.length;
      const ev = this.tryConsume();
      if (ev === null) {
        // Need more bytes.
        if (this.pending.length !== before) {
          // Bytes were consumed without emitting an event (UTF-8 prefix).
          // Loop again to try further.
          continue;
        }
        break;
      }
      out.push(ev);
      if (this.pending.length === 0) break;
    }
    return out;
  }

  /**
   * Try to consume one key sequence from the head of `pending`. Returns
   * the event, or `null` if more input is needed. May consume bytes
   * without emitting (UTF-8 lead byte → continuation).
   */
  private tryConsume(): KeyEvent | null {
    if (this.pending.length === 0) return null;
    const b = this.pending[0];

    // Mid-UTF-8 sequence: accumulate continuation bytes.
    if (this.utf8Expect > 0) {
      if ((b & 0xc0) !== 0x80) {
        // Invalid continuation: drop the lead and continuations, emit unknown.
        this.utf8Bytes.length = 0;
        this.utf8Expect = 0;
        this.pending.shift();
        return { key: 'unknown', raw: new Uint8Array([b]) };
      }
      this.utf8Bytes.push(b);
      this.pending.shift();
      this.utf8Expect--;
      if (this.utf8Expect === 0) {
        const bytes = Uint8Array.from(this.utf8Bytes);
        this.utf8Bytes.length = 0;
        const decoded = utf8Decode(bytes);
        return { key: 'char', char: decoded };
      }
      return null;
    }

    // ASCII printable.
    if (b >= 0x20 && b <= 0x7e) {
      this.pending.shift();
      return { key: 'char', char: String.fromCharCode(b) };
    }

    // Common controls.
    if (b === 0x09) {
      this.pending.shift();
      return { key: 'tab' };
    }
    if (b === 0x0a || b === 0x0d) {
      this.pending.shift();
      return { key: 'enter' };
    }
    if (b === 0x7f || b === 0x08) {
      this.pending.shift();
      return { key: 'backspace' };
    }
    if (b === 0x1b) {
      // Escape: maybe alone, maybe the lead of a CSI/SS3/Meta sequence.
      return this.consumeEscape();
    }
    if (b < 0x20) {
      this.pending.shift();
      return controlEvent(b);
    }

    // UTF-8 lead byte.
    if ((b & 0xe0) === 0xc0) {
      this.utf8Expect = 1;
      this.utf8Bytes = [b];
      this.pending.shift();
      return null;
    }
    if ((b & 0xf0) === 0xe0) {
      this.utf8Expect = 2;
      this.utf8Bytes = [b];
      this.pending.shift();
      return null;
    }
    if ((b & 0xf8) === 0xf0) {
      this.utf8Expect = 3;
      this.utf8Bytes = [b];
      this.pending.shift();
      return null;
    }

    // Stray high byte. Emit unknown.
    this.pending.shift();
    return { key: 'unknown', raw: new Uint8Array([b]) };
  }

  /**
   * Called when the head byte is 0x1b. Tries to consume an escape
   * sequence; returns `null` if more bytes are needed.
   *
   * When only the Esc byte sits in the buffer we have two strategies:
   *
   *   1) `escTimeoutMs === 0` (default for non-LineEditor callers): emit
   *      the bare `escape` immediately. Matches the pre-polish behaviour.
   *   2) `escTimeoutMs > 0`: park the Esc byte, arm a `setTimeout`. If a
   *      follow-on byte arrives within the window, `push()` cancels the
   *      timer and the normal Esc-prefix path runs. Otherwise the timer
   *      fires and we synthesise an `escape` event into the host queue.
   */
  private consumeEscape(): KeyEvent | null {
    if (this.pending.length === 1) {
      if (this.escTimeoutMs === 0) {
        this.pending.shift();
        return { key: 'escape' };
      }
      // Already waiting? Don't re-arm the timer.
      if (this.escPending) return null;
      this.escPending = true;
      this.escTimer = setTimeout(() => {
        this.escTimer = null;
        // If the buffer head is still a lone Esc, drain it as a bare escape.
        if (this.escPending && this.pending[0] === 0x1b) {
          this.pending.shift();
          this.escPending = false;
          this.onTimeoutEvent?.({ key: 'escape' });
        } else {
          this.escPending = false;
        }
      }, this.escTimeoutMs);
      return null;
    }
    const b1 = this.pending[1];

    // Esc [ ... — CSI sequence
    if (b1 === 0x5b /* '[' */) {
      return this.consumeCsi();
    }
    // Esc O X — SS3 (application-mode arrows on many terminals)
    if (b1 === 0x4f /* 'O' */) {
      if (this.pending.length < 3) return null;
      const b2 = this.pending[2];
      this.pending.splice(0, 3);
      return ss3ToEvent(b2);
    }

    // Esc <byte> — Alt/Meta combination.
    if (b1 < 0x20) {
      // Esc + control byte. Treat as Alt-Ctrl-X; we don't currently bind any.
      this.pending.splice(0, 2);
      const inner = controlEvent(b1);
      inner.meta = true;
      return inner;
    }
    if (b1 === 0x7f) {
      this.pending.splice(0, 2);
      return { key: 'backspace', meta: true };
    }
    if (b1 >= 0x20 && b1 <= 0x7e) {
      this.pending.splice(0, 2);
      return { key: 'char', char: String.fromCharCode(b1), meta: true };
    }

    // Unknown Esc-X sequence; consume both and emit unknown.
    const raw = Uint8Array.from(this.pending.slice(0, 2));
    this.pending.splice(0, 2);
    return { key: 'unknown', raw };
  }

  private consumeCsi(): KeyEvent | null {
    // Format: ESC [ (parameter bytes 0x30..0x3f)* (intermediate bytes 0x20..0x2f)* (final byte 0x40..0x7e)
    // We start at pending[2] (after ESC '[').
    let i = 2;
    while (i < this.pending.length) {
      const b = this.pending[i];
      if (b >= 0x40 && b <= 0x7e) break;
      i++;
    }
    if (i === this.pending.length) return null; // need more bytes

    // Examine parameter bytes between pending[2] and pending[i-1].
    const params = this.pending.slice(2, i);
    const final = this.pending[i];
    const seqLen = i + 1;
    const consume = (): void => {
      this.pending.splice(0, seqLen);
    };

    // Bracketed paste markers: ESC [ 200 ~ and ESC [ 201 ~
    if (final === 0x7e /* '~' */) {
      const paramStr = String.fromCharCode(...params);
      consume();
      switch (paramStr) {
        case '1':
        case '7':
          return { key: 'home' };
        case '2':
          return { key: 'unknown' }; // Insert; we don't handle it.
        case '3':
          return { key: 'delete' };
        case '4':
        case '8':
          return { key: 'end' };
        case '5':
          return { key: 'pageup' };
        case '6':
          return { key: 'pagedown' };
        case '200':
          return { key: 'paste-start' };
        case '201':
          return { key: 'paste-end' };
        default:
          return { key: 'unknown' };
      }
    }

    // Letter finals (A/B/C/D/H/F).
    // Param string may carry modifiers: e.g. "1;3" → Alt-arrow.
    const paramStr = String.fromCharCode(...params);
    consume();
    const meta = paramStr.endsWith(';3') || paramStr.endsWith(';7');
    switch (final) {
      case 0x41 /* 'A' */:
        return meta ? { key: 'up', meta: true } : { key: 'up' };
      case 0x42 /* 'B' */:
        return meta ? { key: 'down', meta: true } : { key: 'down' };
      case 0x43 /* 'C' */:
        return meta ? { key: 'right', meta: true } : { key: 'right' };
      case 0x44 /* 'D' */:
        return meta ? { key: 'left', meta: true } : { key: 'left' };
      case 0x48 /* 'H' */:
        return { key: 'home' };
      case 0x46 /* 'F' */:
        return { key: 'end' };
      case 0x5a /* 'Z' */:
        // Shift-Tab; treat as plain Tab for now (no reverse cycling yet).
        return { key: 'tab', meta: true };
      default:
        return {
          key: 'unknown',
          raw: Uint8Array.from(this.pending.slice(0, seqLen)),
        };
    }
  }
}

/** Decode a small UTF-8 byte sequence (1..4 bytes) into a string. */
const utf8Decode = (bytes: Uint8Array): string => {
  // Node provides TextDecoder; available on all supported runtimes (Node 18+).
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
};

/** Translate an SS3 final byte (after `ESC O`) into a key event. */
const ss3ToEvent = (b: number): KeyEvent => {
  switch (b) {
    case 0x41:
      return { key: 'up' };
    case 0x42:
      return { key: 'down' };
    case 0x43:
      return { key: 'right' };
    case 0x44:
      return { key: 'left' };
    case 0x48:
      return { key: 'home' };
    case 0x46:
      return { key: 'end' };
    default:
      return { key: 'unknown', raw: new Uint8Array([0x1b, 0x4f, b]) };
  }
};

// ---------------------------------------------------------------------------
// CSI output helpers
// ---------------------------------------------------------------------------

/** Move cursor up N rows. */
export const csiUp = (n: number): string => (n > 0 ? `\x1b[${n}A` : '');
/** Move cursor down N rows. */
export const csiDown = (n: number): string => (n > 0 ? `\x1b[${n}B` : '');
/** Move cursor right N columns. */
export const csiRight = (n: number): string => (n > 0 ? `\x1b[${n}C` : '');
/** Move cursor left N columns. */
export const csiLeft = (n: number): string => (n > 0 ? `\x1b[${n}D` : '');
/** Move cursor to column N (1-based). */
export const csiToColumn = (col: number): string => `\x1b[${col}G`;
/** Erase from cursor to end-of-line. */
export const csiEraseToEol = (): string => '\x1b[K';
/** Erase entire screen and move cursor to home. */
export const csiClearScreen = (): string => '\x1b[2J\x1b[H';
/** Carriage return: move to column 1 without writing a newline. */
export const CR = '\r';
/** Newline (LF). */
export const LF = '\n';

/** Enable bracketed paste mode (DEC private mode 2004). */
export const enableBracketedPaste = (): string => '\x1b[?2004h';
/** Disable bracketed paste mode. */
export const disableBracketedPaste = (): string => '\x1b[?2004l';

/** Audible bell. */
export const BEL = '\x07';
