/**
 * Public-facing line editor.
 *
 * Glues the streaming VT100 decoder, the keymap, the line buffer, and
 * the completion engine into a `readLine(prompt)` Promise-returning API.
 *
 * Architecture
 * ------------
 *
 *   stdin (raw mode)
 *      │ bytes
 *      ▼
 *   Vt100Decoder ─── KeyEvent[]
 *      │
 *      ▼
 *   dispatch(state, ev) ─── EditorAction
 *      │
 *      ▼
 *   render(prompt, state, stdout)  (CSI writes)
 *      │
 *      └── on submit: resolve readLine() with state.buffer.text
 *      └── on ^C:    reject with SignalError
 *      └── on ^D:    resolve with EOF symbol
 *
 * Rendering strategy
 * ------------------
 *
 *  Naive but robust: track the number of rows last drawn, on every
 *  redraw move the cursor up to the prompt's anchor row and rewrite the
 *  whole `prompt + buffer.text` block. This avoids per-keystroke diffing
 *  bugs at the cost of a few extra bytes per keystroke. For the
 *  ~80-char lines users actually type interactively this is invisible.
 *
 *  Wrapping uses the inlined `displayWidth` (port of WP-09's table) so
 *  East-Asian wide characters and zero-width combining marks render
 *  correctly. We never call `stdout.write` with embedded `\n`; line
 *  breaks come from explicit `\r\n` only on submit or when we need to
 *  display multi-row output (paste-mode newlines, candidate listings).
 */

import { LineBuffer } from './buffer.js';
import {
  dispatch,
  makeState,
  type EditorAction,
  type EditorState,
} from './keymap.js';
import {
  CompletionState,
  type Completer,
  type CompletionResult,
  formatCandidates,
} from './complete.js';
import {
  BEL,
  CR,
  LF,
  Vt100Decoder,
  csiClearScreen,
  csiDown,
  csiEraseToEol,
  csiLeft,
  csiRight,
  csiUp,
  disableBracketedPaste,
  enableBracketedPaste,
  type KeyEvent,
} from './vt100.js';

export type LineEditorOptions = {
  stdin?: NodeJS.ReadStream | NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  history?: string[];
  completer?: Completer;
  bracketedPaste?: boolean;
  /**
   * Editing mode. `'emacs'` (default) keeps the editor in emacs dispatch for
   * the whole readLine; `'vi'` starts each readLine in vi insert mode (Esc to
   * normal). Mirrors upstream readline's `set editing-mode {emacs|vi}`.
   */
  mode?: 'emacs' | 'vi';
  /**
   * Timeout in milliseconds for the bare-Escape disambiguation. When a lone
   * `Esc` byte arrives, the decoder waits up to this long for a follow-on
   * byte before emitting the `escape` key event. Set to `0` to disable (Esc
   * is emitted immediately, matching the pre-WP-24-polish behaviour).
   * Default: 50ms (matches GNU readline's `keyseq-timeout` default).
   */
  escTimeoutMs?: number;
};

/** Thrown when ^C cancels the current line. */
export class SignalError extends Error {
  readonly signal: 'SIGINT';
  constructor() {
    super('SIGINT');
    this.name = 'SignalError';
    this.signal = 'SIGINT';
  }
}

export type { Completer, CompletionResult };

/**
 * Sentinel for "Ctrl-D on an empty line". Compared with `===` by callers
 * so we don't accidentally match a literal string.
 */
const EOF_SYMBOL = Symbol('LineEditor.EOF');

export type ReadLineResult = string | typeof EOF_SYMBOL;

export class LineEditor {
  readonly EOF = EOF_SYMBOL;

  private readonly stdin: NodeJS.ReadStream | NodeJS.ReadableStream;
  private readonly stdout: NodeJS.WritableStream;
  private readonly bracketedPaste: boolean;
  private readonly completer?: Completer;
  private readonly mode: 'emacs' | 'vi';

  private state: EditorState;
  private decoder: Vt100Decoder;
  private completion = new CompletionState();

  /** Event queue; processed serially so async completion blocks subsequent keys. */
  private eventQueue: KeyEvent[] = [];
  private processing = false;

  /** Active readLine, if any. */
  private active: {
    prompt: string;
    resolve: (v: ReadLineResult) => void;
    reject: (e: Error) => void;
    /** Number of terminal rows currently occupied by prompt+line. */
    rowsDrawn: number;
    /** Cursor row within the drawn block (0-based). */
    cursorRow: number;
    /** Cursor column within its row (0-based). */
    cursorCol: number;
    /** Search mode state, when active. */
    search: SearchState | null;
    /**
     * Number of terminal rows occupied by a candidate listing currently drawn
     * BELOW the prompt block. `0` when no listing is on screen. Used to do
     * in-place rewrites on Tab cycle (cursor up by this much, redraw with the
     * new highlight, move back).
     */
    listingRowsDrawn: number;
  } | null = null;

  /** Listeners attached to stdin while readLine is active. */
  private dataListener: ((chunk: Buffer) => void) | null = null;
  private wasRaw = false;
  /** TTY state restoration handlers. */
  private exitListener: (() => void) | null = null;

  constructor(opts: LineEditorOptions = {}) {
    this.stdin = opts.stdin ?? process.stdin;
    this.stdout = opts.stdout ?? process.stdout;
    this.bracketedPaste = opts.bracketedPaste ?? true;
    this.completer = opts.completer;
    this.mode = opts.mode ?? 'emacs';
    this.state = makeState(
      opts.history ?? [],
      this.mode === 'vi' ? 'insert' : 'emacs',
    );
    this.decoder = new Vt100Decoder({
      // LineEditor default: 50ms matches GNU readline's `keyseq-timeout`
      // default — enough to disambiguate Alt-X across all modern terminals
      // without making bare Esc noticeably laggy. Callers can override (or
      // set 0 to restore the legacy "emit Esc immediately" behaviour).
      escTimeoutMs: opts.escTimeoutMs ?? 50,
      onTimeoutEvent: (ev): void => {
        this.handleDecoderTimeout(ev);
      },
    });
  }

  /** Read one line. Resolves on Enter; rejects on Ctrl-C. */
  readLine(prompt: string): Promise<ReadLineResult> {
    if (this.active !== null) {
      return Promise.reject(
        new Error('LineEditor.readLine called re-entrantly'),
      );
    }
    return new Promise<ReadLineResult>((resolve, reject) => {
      // Fresh buffer for the new prompt.
      this.state.buffer = new LineBuffer();
      this.state.historyIndex = -1;
      this.state.liveSnapshot = null;
      // Vi: every new readLine starts in insert mode (per upstream readline).
      if (this.mode === 'vi') {
        this.state.mode = 'insert';
        this.state.viPending = null;
      }
      this.completion.reset();
      this.active = {
        prompt,
        resolve,
        reject,
        rowsDrawn: 0,
        cursorRow: 0,
        cursorCol: 0,
        search: null,
        listingRowsDrawn: 0,
      };
      try {
        this.enterRaw();
      } catch (err) {
        this.active = null;
        reject(err as Error);
        return;
      }
      this.render();
    });
  }

  /** Force redraw (call from SIGWINCH handler). */
  redraw(): void {
    if (this.active !== null) this.render(true);
  }

  /**
   * Inject an out-of-band line into the terminal while a prompt is being
   * edited. Used by callers that produce async output (NOTIFY messages,
   * notices, etc.) that would otherwise clobber the prompt rendering.
   *
   * Behaviour:
   *   - No active readLine: pass-through to stdout.
   *   - Active readLine: move cursor to end-of-block, write a fresh newline
   *     so the injected text starts on its own row, write the text, then
   *     redraw the prompt + buffer below it (re-attaching the cursor).
   *
   * The injected text should NOT have a trailing newline — we add one as
   * part of the move-to-end + LF dance. If the caller's payload already
   * ends with `\n`, we strip it once.
   */
  interject(text: string): void {
    if (this.active === null) {
      this.stdout.write(text);
      return;
    }
    const a = this.active;
    this.moveCursorToEnd();
    this.stdout.write(LF);
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    this.stdout.write(body);
    this.stdout.write(LF);
    // Reset drawn-state so render() lays out a fresh block under the
    // injected text instead of trying to overwrite the area we just used.
    a.rowsDrawn = 0;
    a.cursorRow = 0;
    a.cursorCol = 0;
    // Interjected text overwrites any candidate listing that was on screen.
    a.listingRowsDrawn = 0;
    this.render(true);
  }

  /** Cleanup raw mode and restore TTY. Idempotent. */
  close(): void {
    this.exitRaw();
  }

  /** Push a line into the in-memory history. */
  pushHistory(line: string): void {
    if (line.length === 0) return;
    const last = this.state.history[this.state.history.length - 1];
    if (last === line) return;
    this.state.history.push(line);
  }

  /** Replace the in-memory history list. */
  setHistory(lines: string[]): void {
    this.state.history = lines.slice();
    this.state.historyIndex = -1;
    this.state.liveSnapshot = null;
  }

  // -------------------------------------------------------------------------
  // I/O wiring
  // -------------------------------------------------------------------------

  private enterRaw(): void {
    const s = this.stdin;
    if (isTtyReadStream(s)) {
      this.wasRaw = Boolean(s.isRaw);
      s.setRawMode(true);
    }
    s.resume();
    this.decoder.reset();
    if (this.bracketedPaste) this.stdout.write(enableBracketedPaste());

    this.dataListener = (chunk: Buffer): void => {
      this.handleChunk(chunk);
    };
    s.on('data', this.dataListener);

    if (!this.exitListener) {
      this.exitListener = (): void => {
        this.exitRaw();
      };
      process.once('exit', this.exitListener);
      process.once('SIGTERM', this.exitListener);
    }
  }

  private exitRaw(): void {
    const s = this.stdin;
    if (this.dataListener !== null) {
      s.off('data', this.dataListener);
      this.dataListener = null;
    }
    if (isTtyReadStream(s) && !this.wasRaw) {
      try {
        s.setRawMode(false);
      } catch {
        /* ignore */
      }
    }
    if (this.bracketedPaste) {
      try {
        this.stdout.write(disableBracketedPaste());
      } catch {
        /* ignore */
      }
    }
    if (this.exitListener !== null) {
      process.off('exit', this.exitListener);
      process.off('SIGTERM', this.exitListener);
      this.exitListener = null;
    }
  }

  // -------------------------------------------------------------------------
  // Chunk processing
  // -------------------------------------------------------------------------

  private handleChunk(chunk: Buffer): void {
    if (this.active === null) return;
    const events = this.decoder.push(new Uint8Array(chunk));
    for (const ev of events) this.eventQueue.push(ev);
    void this.drainQueue();
  }

  /** Called when the decoder's bare-Esc timer fires with a buffered event. */
  private handleDecoderTimeout(ev: KeyEvent): void {
    if (this.active === null) return;
    this.eventQueue.push(ev);
    void this.drainQueue();
  }

  /**
   * Serially drain the event queue. Each event may kick off async work
   * (notably Tab completion); we await it before processing the next
   * event so keystrokes don't race ahead of pending completion results.
   */
  private async drainQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.eventQueue.length > 0 && this.active !== null) {
        const ev = this.eventQueue.shift();
        if (ev === undefined) break;
        await this.handleEvent(ev);
      }
    } finally {
      this.processing = false;
    }
  }

  private async handleEvent(ev: KeyEvent): Promise<void> {
    if (this.active === null) return;
    const a = this.active;

    // Search mode handling is local: events go into the search state machine
    // instead of the keymap.
    if (a.search !== null) {
      await this.handleSearchKey(ev);
      return;
    }

    const action = dispatch(this.state, ev);
    await this.applyAction(action, ev);
  }

  /**
   * Reset the completion engine and forget any listing geometry: the next Tab
   * will request a fresh result, and the next `list` / `cycled` will emit a
   * new block on a fresh row instead of trying to overwrite a stale listing
   * whose coordinates are no longer valid.
   */
  private resetCompletion(): void {
    this.completion.reset();
    if (this.active !== null) this.active.listingRowsDrawn = 0;
  }

  private async applyAction(action: EditorAction, ev: KeyEvent): Promise<void> {
    if (this.active === null) return;
    const a = this.active;
    switch (action.kind) {
      case 'noop':
        return;
      case 'redraw':
        this.resetCompletion();
        this.render();
        return;
      case 'bell':
        this.stdout.write(BEL);
        return;
      case 'submit': {
        this.resetCompletion();
        const text = this.state.buffer.text;
        // Move cursor past the end of the rendered block and emit a newline.
        this.moveCursorToEnd();
        this.stdout.write(LF);
        const resolve = a.resolve;
        this.active = null;
        this.exitRaw();
        resolve(text);
        return;
      }
      case 'cancel': {
        // Upstream psql doesn't echo `^C` to the screen on Ctrl-C — it just
        // breaks to the next prompt line silently. Match that behaviour.
        this.resetCompletion();
        this.moveCursorToEnd();
        this.stdout.write(LF);
        const reject = a.reject;
        this.active = null;
        this.exitRaw();
        reject(new SignalError());
        return;
      }
      case 'eof': {
        this.resetCompletion();
        this.moveCursorToEnd();
        this.stdout.write(LF);
        const resolve = a.resolve;
        this.active = null;
        this.exitRaw();
        resolve(EOF_SYMBOL);
        return;
      }
      case 'complete': {
        if (!this.completer) {
          this.stdout.write(BEL);
          return;
        }
        await this.runCompletion();
        return;
      }
      case 'clear-screen':
        this.resetCompletion();
        this.stdout.write(csiClearScreen());
        a.rowsDrawn = 0;
        a.cursorRow = 0;
        a.cursorCol = 0;
        this.render(true);
        return;
      case 'search-start':
        this.resetCompletion();
        a.search = {
          pattern: '',
          matchIndex: null,
          savedBuffer: this.state.buffer.text,
        };
        this.render();
        return;
      case 'paste-start':
      case 'paste-end':
        // Bracketed paste markers are otherwise transparent.
        void ev;
        return;
      case 'ex-update':
        // Vi `:`-ex prompt text changed (entered/typed/backspaced). The
        // renderer reads `state.mode === 'ex'` and swaps in a `: <buf>` line.
        this.resetCompletion();
        this.render();
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------

  private async runCompletion(): Promise<void> {
    if (this.completer === undefined || this.active === null) return;
    const step = await this.completion.apply(this.state.buffer, this.completer);
    if (this.active === null) return;
    switch (step.kind) {
      case 'bell':
        this.stdout.write(BEL);
        return;
      case 'inserted':
        this.render();
        return;
      case 'cycled': {
        // In-place rewrite of the candidate listing with the new highlight.
        // If we already have a listing on screen (placed above the current
        // prompt block by an earlier `list` or `cycled`), navigate up to its
        // first row, erase each row, and reprint with the cycled highlight.
        // Otherwise fall back to the "print listing below" path, matching
        // first-time `list` behaviour.
        const cands = this.completion.getCandidates();
        const cycleIndex = this.completion.getCycleIndex();
        if (cands.length > 0) {
          const w = this.termWidth();
          const block = formatCandidates(cands, w, cycleIndex);
          const blockRows = block.split('\n').length;
          if (this.active.listingRowsDrawn > 0) {
            this.rewriteListingInPlace(block, blockRows);
          } else {
            this.emitListingBelow(block, blockRows);
          }
        } else {
          this.render();
        }
        return;
      }
      case 'list': {
        // Print listing on a new row, then redraw the prompt+line below it.
        const w = this.termWidth();
        const block = formatCandidates(step.candidates, w);
        const blockRows = block.split('\n').length;
        this.emitListingBelow(block, blockRows);
        return;
      }
    }
  }

  /**
   * Print `block` on fresh rows below the prompt block, then redraw the
   * prompt + buffer below it. Remembers how many rows the listing occupies
   * in `listingRowsDrawn` so a subsequent cycle can rewrite it in place.
   */
  private emitListingBelow(block: string, blockRows: number): void {
    if (this.active === null) return;
    this.moveCursorToEnd();
    this.stdout.write(LF);
    this.stdout.write(block + LF);
    this.active.rowsDrawn = 0;
    this.active.cursorRow = 0;
    this.active.cursorCol = 0;
    this.active.listingRowsDrawn = blockRows;
    this.render(true);
  }

  /**
   * Rewrite the candidate listing in place. Pre-condition: a listing of
   * `this.active.listingRowsDrawn` rows is currently drawn just above the
   * prompt block.
   *
   *   1) Step up to the FIRST row of the listing (past the prompt block).
   *   2) Erase + reprint each listing row.
   *   3) Move back down past any trailing erase, then redraw prompt + buffer.
   *
   * If `block` has a different row count from the old listing the difference
   * is absorbed by clearing extra rows (shrinking) or by accepting some
   * scroll (growing — rare in practice because the candidate list is fixed
   * for the duration of a cycle).
   */
  private rewriteListingInPlace(block: string, blockRows: number): void {
    if (this.active === null) return;
    const a = this.active;
    const oldRows = a.listingRowsDrawn;
    // 1. Cursor is somewhere inside the prompt block. Anchor to row 0 of the
    //    prompt block first.
    this.stdout.write(CR);
    if (a.cursorRow > 0) this.stdout.write(csiUp(a.cursorRow));
    // 2. Step up `oldRows` more rows so the cursor sits on the first row of
    //    the listing.
    this.stdout.write(csiUp(oldRows));
    // 3. Erase each listing row and write the new block. We treat the listing
    //    as `blockRows` lines separated by LF; on the last line we DON'T emit
    //    a trailing LF (otherwise we'd push the prompt down by one row).
    const newLines = block.split('\n');
    for (let i = 0; i < newLines.length; i++) {
      this.stdout.write(csiEraseToEol());
      this.stdout.write(newLines[i]);
      if (i < newLines.length - 1) this.stdout.write(LF + CR);
    }
    // 4. If the new block is shorter than the old one, clear the leftover
    //    rows below.
    if (blockRows < oldRows) {
      const extra = oldRows - blockRows;
      for (let i = 0; i < extra; i++) {
        this.stdout.write(LF + CR + csiEraseToEol());
      }
      // Step back up so the cursor sits right under the last listing line.
      this.stdout.write(csiUp(extra));
    }
    // 5. Move past the listing onto the row where the prompt should start.
    this.stdout.write(LF + CR);
    // 6. The prompt's geometry needs to be redrawn fresh below the listing.
    a.rowsDrawn = 0;
    a.cursorRow = 0;
    a.cursorCol = 0;
    a.listingRowsDrawn = blockRows;
    this.render(true);
  }

  // -------------------------------------------------------------------------
  // Reverse-incremental-search
  // -------------------------------------------------------------------------

  private async handleSearchKey(ev: KeyEvent): Promise<void> {
    if (this.active?.search == null) return;
    const s = this.active.search;

    // ^G or Escape cancels and restores the saved line.
    if (
      (ev.key === 'char' && ev.ctrl && ev.char === 'g') ||
      ev.key === 'escape'
    ) {
      this.state.buffer.setText(s.savedBuffer);
      this.active.search = null;
      this.render();
      return;
    }
    // Enter accepts the current match (whatever's in the buffer).
    if (ev.key === 'enter') {
      this.active.search = null;
      await this.applyAction({ kind: 'submit' }, ev);
      return;
    }
    // ^C bubbles to cancel.
    if (ev.key === 'char' && ev.ctrl && ev.char === 'c') {
      await this.applyAction({ kind: 'cancel' }, ev);
      return;
    }
    // ^R again: search further back.
    if (ev.key === 'char' && ev.ctrl && ev.char === 'r') {
      this.searchStep(-1);
      return;
    }
    // Backspace: shrink the pattern.
    if (ev.key === 'backspace') {
      s.pattern = s.pattern.slice(0, -1);
      s.matchIndex = null;
      this.searchStep(0);
      return;
    }
    // Printable char: extend the pattern.
    if (ev.key === 'char' && !ev.ctrl && !ev.meta && ev.char !== undefined) {
      s.pattern += ev.char;
      s.matchIndex = null;
      this.searchStep(0);
      return;
    }
    // Anything else (arrows, etc) accepts the match and processes the key.
    this.active.search = null;
    await this.handleEvent(ev);
  }

  /** Walk history backward looking for the current pattern. */
  private searchStep(delta: number): void {
    if (this.active?.search == null) return;
    const s = this.active.search;
    const hist = this.state.history;
    const startFrom =
      s.matchIndex === null ? hist.length - 1 : s.matchIndex + delta;
    for (let i = startFrom; i >= 0 && i < hist.length; i--) {
      if (s.pattern === '' || hist[i].includes(s.pattern)) {
        s.matchIndex = i;
        this.state.buffer.setText(hist[i]);
        this.render();
        return;
      }
    }
    // No match: ring bell, keep current buffer.
    this.stdout.write(BEL);
    this.render();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /**
   * Repaint the prompt + buffer. If `full` is true, skip the cursor-up
   * optimisation (we don't know the previous geometry).
   */
  private render(full = false): void {
    if (this.active === null) return;
    const a = this.active;

    // Move the cursor back to row 0 of the previously drawn block.
    if (!full && a.rowsDrawn > 0) {
      // Move up to the anchor row.
      const up = a.cursorRow;
      this.stdout.write(CR + (up > 0 ? csiUp(up) : ''));
    } else {
      this.stdout.write(CR);
    }

    // Compose the output: prompt + buffer text, with line wrapping computed
    // virtually so we know where the cursor ends up.
    const width = Math.max(1, this.termWidth());
    // Pick the prompt + rendered text for the three render flavours:
    //   - vi ex-mode (`:`-prompt): `: <exBuffer>`, cursor at the end.
    //   - reverse-i-search:        the `(reverse-i-search)\`pat':` preamble,
    //                              with the matched pattern highlighted.
    //   - default editing:         the caller-supplied prompt + buffer text.
    const inExMode = this.state.mode === 'ex';
    const promptStr = inExMode
      ? ':'
      : a.search === null
        ? a.prompt
        : `(reverse-i-search)\`${a.search.pattern}': `;
    const rawText = inExMode
      ? this.state.exBuffer
      : this.state.buffer.text.replace(/\n/g, '⏎'); // newline glyph
    // For search rendering we highlight the matched pattern (case-insensitive)
    // inside the matched entry; otherwise the rendered text equals the raw text.
    const renderText =
      !inExMode && a.search !== null && a.search.pattern.length > 0
        ? highlightMatch(rawText, a.search.pattern)
        : rawText;

    const promptWidth = displayWidth(promptStr);
    // Cursor positioning uses the raw text length, NOT the rendered text
    // length, because ANSI escapes have zero display width but non-zero
    // string length. In ex mode the cursor always sits at the end of the
    // ex buffer.
    const beforeText = inExMode
      ? rawText
      : rawText.slice(0, this.codePointsBeforeCursor().length);
    const allText = renderText;

    // Compute physical row/col for cursor.
    const { row: cursorRow, col: cursorCol } = positionAfter(
      promptWidth,
      beforeText,
      width,
    );
    // Compute final row/col for the full block (so we know how many rows).
    // Strip ANSI escape sequences from the geometry calculation since they
    // have zero display width but non-zero string length.
    const { row: lastRow } = positionAfter(
      promptWidth,
      stripAnsi(allText),
      width,
    );
    const rowsDrawn = lastRow + 1;

    // Write the line. We erase each row first so leftover chars from a longer
    // previous render are scrubbed.
    this.stdout.write(csiEraseToEol());
    this.stdout.write(promptStr);
    this.stdout.write(allText);

    // After writing, if the previous render had more rows than this one,
    // erase the leftover rows.
    if (a.rowsDrawn > rowsDrawn) {
      const extra = a.rowsDrawn - rowsDrawn;
      for (let i = 0; i < extra; i++) {
        this.stdout.write(LF + csiEraseToEol());
      }
      // Move back up to where we are.
      this.stdout.write(csiUp(extra));
    }

    // Reposition cursor.
    // After writing `allText`, cursor is at (lastRow, lastCol). We want
    // (cursorRow, cursorCol).
    const rowDelta = cursorRow - lastRow;
    if (rowDelta < 0) this.stdout.write(csiUp(-rowDelta));
    if (rowDelta > 0) this.stdout.write(csiDown(rowDelta));

    this.stdout.write(CR);
    if (cursorCol > 0) this.stdout.write(csiRight(cursorCol));

    a.rowsDrawn = rowsDrawn;
    a.cursorRow = cursorRow;
    a.cursorCol = cursorCol;
    // Silence unused.
    void csiLeft;
  }

  private moveCursorToEnd(): void {
    if (this.active === null) return;
    const a = this.active;
    // Step down to the final row of the current render.
    const down = a.rowsDrawn - 1 - a.cursorRow;
    if (down > 0) this.stdout.write(csiDown(down));
    this.stdout.write(CR);
    a.cursorRow = a.rowsDrawn - 1;
    a.cursorCol = 0;
  }

  private codePointsBeforeCursor(): { length: number } {
    return { length: this.state.buffer.cursor };
  }

  private termWidth(): number {
    const s = this.stdout as NodeJS.WriteStream;
    if (typeof s.columns === 'number' && s.columns > 0) return s.columns;
    return 80;
  }
}

type SearchState = {
  pattern: string;
  /** Index in history of the current match, or null if none. */
  matchIndex: number | null;
  /** Buffer contents at the time search started. */
  savedBuffer: string;
};

const isTtyReadStream = (
  s: NodeJS.ReadStream | NodeJS.ReadableStream,
): s is NodeJS.ReadStream =>
  typeof (s as NodeJS.ReadStream).setRawMode === 'function';

// ---------------------------------------------------------------------------
// Search-line rendering / highlighting
// ---------------------------------------------------------------------------

const SGR_REVERSE = '\x1b[7m';
const SGR_NO_REVERSE = '\x1b[27m';

/**
 * Wrap the first case-insensitive occurrence of `pattern` inside `text`
 * with the reverse-video SGR pair. Returns `text` unchanged when the
 * pattern is empty or not found.
 *
 * Kept as a pure helper for unit-testing (the renderer calls it during
 * search mode, but `renderSearchLine` is the unit-testable surface).
 */
export const highlightMatch = (text: string, pattern: string): string => {
  if (pattern.length === 0) return text;
  const lcText = text.toLowerCase();
  const lcPat = pattern.toLowerCase();
  const idx = lcText.indexOf(lcPat);
  if (idx < 0) return text;
  return (
    text.slice(0, idx) +
    SGR_REVERSE +
    text.slice(idx, idx + pattern.length) +
    SGR_NO_REVERSE +
    text.slice(idx + pattern.length)
  );
};

/**
 * Render the search prompt + matched entry as a single string, with the
 * matched pattern highlighted via reverse video. Exposed for unit tests.
 * The real interactive renderer applies the same logic inline.
 */
export const renderSearchLine = (pattern: string, entry: string): string => {
  const prefix = `(reverse-i-search)\`${pattern}': `;
  return prefix + highlightMatch(entry, pattern);
};

/** Strip ANSI CSI escape sequences from `text` for display-width math. */
const stripAnsi = (text: string): string =>
  // Targets the SGR forms we emit (e.g. \x1b[7m, \x1b[27m). Kept narrow on
  // purpose so it doesn't accidentally eat legitimate `[` characters.
  // eslint-disable-next-line no-control-regex
  text.replace(/\x1b\[[0-9;]*m/g, '');

// ---------------------------------------------------------------------------
// Display-width helpers (inlined copy of WP-09's tables; kept minimal).
// ---------------------------------------------------------------------------

const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

const ZERO_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x05bf, 0x05bf],
  [0x05c1, 0x05c2],
  [0x05c4, 0x05c5],
  [0x05c7, 0x05c7],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x06df, 0x06e4],
  [0x06e7, 0x06e8],
  [0x06ea, 0x06ed],
  [0x0711, 0x0711],
  [0x0730, 0x074a],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x20d0, 0x20f0],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
  [0xe0100, 0xe01ef],
];

const inRange = (
  cp: number,
  ranges: readonly (readonly [number, number])[],
): boolean => {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = ranges[mid];
    if (cp < entry[0]) hi = mid - 1;
    else if (cp > entry[1]) lo = mid + 1;
    else return true;
  }
  return false;
};

const codePointWidth = (cp: number): number => {
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (inRange(cp, ZERO_RANGES)) return 0;
  if (inRange(cp, WIDE_RANGES)) return 2;
  return 1;
};

const displayWidth = (text: string): number => {
  let w = 0;
  for (const ch of text) w += codePointWidth(ch.codePointAt(0) ?? 0);
  return w;
};

/**
 * Compute the final (row, col) position after writing `text` to a
 * terminal whose cursor starts at column `startCol` and is `width`
 * columns wide. Wrapping happens by display column count, not code points.
 */
const positionAfter = (
  startCol: number,
  text: string,
  width: number,
): { row: number; col: number } => {
  let row = 0;
  let col = startCol % width;
  // Initial wrap if startCol exactly hit the width boundary.
  if (col === 0 && startCol > 0) {
    row += Math.floor(startCol / width);
  } else {
    row += Math.floor(startCol / width);
  }
  for (const ch of text) {
    if (ch === '\n') {
      row += 1;
      col = 0;
      continue;
    }
    const w = codePointWidth(ch.codePointAt(0) ?? 0);
    if (col + w > width) {
      row += 1;
      col = w;
    } else {
      col += w;
      if (col === width) {
        // Stay on this row; next char triggers the wrap.
        // (Real terminals differ here; the conservative choice that matches
        // most xterm derivatives is to NOT advance row until the next glyph.)
      }
    }
  }
  return { row, col };
};
