/**
 * Emacs keymap dispatch.
 *
 * Pure function: take a `KeyEvent` plus the current editor state, mutate
 * the state, and return an `Action` describing what the renderer / outer
 * loop should do (redraw, submit, signal cancel, request completion, …).
 *
 * The state lives in `EditorState`, which wraps a `LineBuffer` plus a
 * little extra context (history navigation, last-tab timestamp, search
 * mode). Keeping dispatch separate from rendering means we can write
 * deterministic key-by-key tests without touching a TTY.
 */

import { LineBuffer } from './buffer.js';
import type { KeyEvent } from './vt100.js';

/** Actions the dispatch loop reports back to the outer driver. */
export type EditorAction =
  | { kind: 'noop' }
  | { kind: 'redraw' }
  | { kind: 'bell' }
  | { kind: 'submit' }
  | { kind: 'cancel' } // ^C: abort current line, throw SignalError
  | { kind: 'eof' } // ^D on empty buffer
  | { kind: 'complete' } // Tab pressed
  | { kind: 'clear-screen' }
  | { kind: 'search-start' } // ^R pressed (driver enters i-search loop)
  | { kind: 'paste-start' }
  | { kind: 'paste-end' };

/**
 * Editor mode:
 *   - 'emacs'  — the default; emacs-only dispatch (no vi modal behavior).
 *   - 'insert' — vi insert mode: printable keys insert, Esc switches to normal.
 *   - 'normal' — vi command mode: motions and edits.
 *
 * `'insert'` and `'normal'` are only used when the LineEditor was constructed
 * with `mode: 'vi'`; in that case each new readLine starts in `'insert'`.
 */
export type EditorMode = 'emacs' | 'insert' | 'normal';

/**
 * Multi-key vi command prefix awaiting its next byte. `null` when no operator
 * is pending. `'r'` means "next char replaces the char at cursor". `'d'`,
 * `'c'`, and `'g'` are vi operators waiting on a motion (e.g. `dw`, `cw`).
 */
export type ViPending = null | 'r' | 'd' | 'c' | 'g';

/** Tracks the mini-state machine that surrounds the buffer. */
export type EditorState = {
  buffer: LineBuffer;
  /** History entries in chronological order (oldest first). */
  history: string[];
  /**
   * Index into history when navigating with ^P/^N. -1 means "live line"
   * (not navigating). 0 means oldest entry, history.length-1 newest.
   *
   * When the user starts navigating we save the live line into
   * `liveSnapshot` so ^N back to "after the newest entry" can restore it.
   */
  historyIndex: number;
  liveSnapshot: string | null;
  /** Tracks the most recent yank's text for M-y. */
  lastYank: string | null;
  /** True while inside a bracketed-paste block. */
  pasting: boolean;
  /** Current editor mode. */
  mode: EditorMode;
  /** Pending vi operator awaiting its next byte. */
  viPending: ViPending;
};

export const makeState = (
  history: string[] = [],
  mode: EditorMode = 'emacs',
): EditorState => ({
  buffer: new LineBuffer(),
  history: [...history],
  historyIndex: -1,
  liveSnapshot: null,
  lastYank: null,
  pasting: false,
  mode,
  viPending: null,
});

/**
 * Apply one key event. Returns the resulting action for the outer loop.
 * All mutation happens in `state.buffer` (or the navigation fields).
 */
export const dispatch = (state: EditorState, ev: KeyEvent): EditorAction => {
  if (state.pasting) {
    // Inside a bracketed-paste block we treat every event as a literal char,
    // except the closing marker.
    if (ev.key === 'paste-end') {
      state.pasting = false;
      return { kind: 'paste-end' };
    }
    if (ev.key === 'char' && ev.char !== undefined && !ev.ctrl && !ev.meta) {
      state.buffer.insert(ev.char);
      return { kind: 'redraw' };
    }
    if (ev.key === 'enter') {
      state.buffer.insert('\n');
      return { kind: 'redraw' };
    }
    if (ev.key === 'tab') {
      state.buffer.insert('\t');
      return { kind: 'redraw' };
    }
    return { kind: 'noop' };
  }

  // ^C always cancels regardless of mode.
  if (ev.key === 'char' && ev.ctrl && ev.char === 'c') {
    state.viPending = null;
    return { kind: 'cancel' };
  }

  // Route to vi dispatch when in vi modes.
  if (state.mode === 'normal') {
    return dispatchViNormal(state, ev);
  }
  if (state.mode === 'insert') {
    return dispatchViInsert(state, ev);
  }

  switch (ev.key) {
    case 'paste-start':
      state.pasting = true;
      return { kind: 'paste-start' };

    case 'paste-end':
      state.pasting = false;
      return { kind: 'paste-end' };

    case 'enter':
      return { kind: 'submit' };

    case 'tab':
      return { kind: 'complete' };

    case 'backspace':
      if (ev.meta) {
        state.buffer.killWordLeft();
      } else {
        state.buffer.deleteLeft();
      }
      return { kind: 'redraw' };

    case 'delete':
      state.buffer.deleteRight();
      return { kind: 'redraw' };

    case 'left':
      if (ev.meta) state.buffer.moveWordLeft();
      else state.buffer.moveLeft();
      return { kind: 'redraw' };

    case 'right':
      if (ev.meta) state.buffer.moveWordRight();
      else state.buffer.moveRight();
      return { kind: 'redraw' };

    case 'up':
      return navigateHistory(state, -1);

    case 'down':
      return navigateHistory(state, +1);

    case 'home':
      state.buffer.moveHome();
      return { kind: 'redraw' };

    case 'end':
      state.buffer.moveEnd();
      return { kind: 'redraw' };

    case 'escape':
      // Bare Escape: ignore (Alt prefixes are decoded into meta:true).
      return { kind: 'noop' };

    case 'char':
      return handleChar(state, ev);

    case 'pageup':
    case 'pagedown':
    case 'unknown':
      return { kind: 'bell' };
  }
};

const handleChar = (state: EditorState, ev: KeyEvent): EditorAction => {
  const ch = ev.char ?? '';
  if (ch.length === 0) return { kind: 'noop' };

  if (ev.ctrl) {
    switch (ch) {
      case 'a':
        state.buffer.moveHome();
        return { kind: 'redraw' };
      case 'e':
        state.buffer.moveEnd();
        return { kind: 'redraw' };
      case 'b':
        state.buffer.moveLeft();
        return { kind: 'redraw' };
      case 'f':
        state.buffer.moveRight();
        return { kind: 'redraw' };
      case 'p':
        return navigateHistory(state, -1);
      case 'n':
        return navigateHistory(state, +1);
      case 'k':
        state.buffer.killToEnd();
        return { kind: 'redraw' };
      case 'u':
        state.buffer.killToStart();
        return { kind: 'redraw' };
      case 'w':
        state.buffer.killWordLeft();
        return { kind: 'redraw' };
      case 'y': {
        const yanked = state.buffer.yank();
        state.lastYank = yanked ?? null;
        return yanked === undefined ? { kind: 'bell' } : { kind: 'redraw' };
      }
      case 'c':
        return { kind: 'cancel' };
      case 'd':
        if (state.buffer.length === 0) return { kind: 'eof' };
        state.buffer.deleteRight();
        return { kind: 'redraw' };
      case 'l':
        return { kind: 'clear-screen' };
      case 'h':
        state.buffer.deleteLeft();
        return { kind: 'redraw' };
      case 'r':
        return { kind: 'search-start' };
      case 't': {
        // Transpose two chars before cursor. Edge cases per readline:
        //  - at end-of-line, transpose the two chars before cursor
        //  - at the very start with <2 chars, bell
        transpose(state.buffer);
        return { kind: 'redraw' };
      }
      case '_':
      case '/': // some terminals send ^/ as 0x1f
        return state.buffer.undo() ? { kind: 'redraw' } : { kind: 'bell' };
      case 'g':
        // ^G outside of search is a no-op bell.
        return { kind: 'bell' };
      default:
        return { kind: 'bell' };
    }
  }

  if (ev.meta) {
    switch (ch) {
      case 'b':
      case 'B':
        state.buffer.moveWordLeft();
        return { kind: 'redraw' };
      case 'f':
      case 'F':
        state.buffer.moveWordRight();
        return { kind: 'redraw' };
      case 'd':
      case 'D':
        state.buffer.killWordRight();
        return { kind: 'redraw' };
      case 'y':
      case 'Y':
        if (state.lastYank === null) return { kind: 'bell' };
        {
          const next = state.buffer.yankPop(state.lastYank);
          if (next === undefined) return { kind: 'bell' };
          state.lastYank = next;
        }
        return { kind: 'redraw' };
      default:
        return { kind: 'bell' };
    }
  }

  // Plain printable.
  state.buffer.insert(ch);
  return { kind: 'redraw' };
};

/**
 * Move history index by delta and load the corresponding entry. Saves
 * the live line on the first upward step so the user can return to it.
 */
const navigateHistory = (state: EditorState, delta: number): EditorAction => {
  if (state.history.length === 0) return { kind: 'bell' };

  if (state.historyIndex === -1) {
    if (delta < 0) {
      state.liveSnapshot = state.buffer.text;
      state.historyIndex = state.history.length - 1;
      state.buffer.setText(state.history[state.historyIndex]);
      return { kind: 'redraw' };
    }
    return { kind: 'bell' };
  }

  const next = state.historyIndex + delta;
  if (next < 0) return { kind: 'bell' };
  if (next >= state.history.length) {
    // Stepped past newest: restore the live snapshot.
    state.historyIndex = -1;
    state.buffer.setText(state.liveSnapshot ?? '');
    state.liveSnapshot = null;
    return { kind: 'redraw' };
  }
  state.historyIndex = next;
  state.buffer.setText(state.history[next]);
  return { kind: 'redraw' };
};

// ---------------------------------------------------------------------------
// vi mode
// ---------------------------------------------------------------------------

/**
 * Vi insert-mode dispatch. Behaves mostly like emacs for editing primitives —
 * printable keys insert, backspace/delete/arrows work the same way — but Esc
 * switches into normal mode. Ctrl keys are intentionally NOT vi commands here
 * (^C is handled at the top of `dispatch`).
 */
const dispatchViInsert = (state: EditorState, ev: KeyEvent): EditorAction => {
  switch (ev.key) {
    case 'paste-start':
      state.pasting = true;
      return { kind: 'paste-start' };

    case 'paste-end':
      state.pasting = false;
      return { kind: 'paste-end' };

    case 'enter':
      return { kind: 'submit' };

    case 'tab':
      return { kind: 'complete' };

    case 'escape':
      // Leave insert mode; vi convention: cursor steps left so it sits on the
      // last inserted char (unless we were already at column 0).
      state.mode = 'normal';
      state.viPending = null;
      if (state.buffer.cursor > 0) state.buffer.moveLeft();
      return { kind: 'redraw' };

    case 'backspace':
      state.buffer.deleteLeft();
      return { kind: 'redraw' };

    case 'delete':
      state.buffer.deleteRight();
      return { kind: 'redraw' };

    case 'left':
      state.buffer.moveLeft();
      return { kind: 'redraw' };

    case 'right':
      state.buffer.moveRight();
      return { kind: 'redraw' };

    case 'up':
      return navigateHistory(state, -1);

    case 'down':
      return navigateHistory(state, +1);

    case 'home':
      state.buffer.moveHome();
      return { kind: 'redraw' };

    case 'end':
      state.buffer.moveEnd();
      return { kind: 'redraw' };

    case 'char': {
      const ch = ev.char ?? '';
      if (ch.length === 0) return { kind: 'noop' };
      // ^D on empty buffer still acts as EOF in either vi mode.
      if (ev.ctrl && ch === 'd' && state.buffer.length === 0) {
        return { kind: 'eof' };
      }
      // Ignore other control combos in vi insert; just insert plain printables.
      if (ev.ctrl || ev.meta) return { kind: 'noop' };
      state.buffer.insert(ch);
      return { kind: 'redraw' };
    }

    case 'pageup':
    case 'pagedown':
    case 'unknown':
      return { kind: 'bell' };
  }
};

/**
 * Vi normal-mode dispatch. Implements the core motion + edit subset documented
 * in the WP-24 plan: hjkl/0$^/bwe movement, x/X/dd/D/cc/cw/r/~ edits, i/a/I/A
 * to switch back to insert. Multi-key sequences (dd, cw, r<char>) are tracked
 * via `state.viPending`.
 */
const dispatchViNormal = (state: EditorState, ev: KeyEvent): EditorAction => {
  // Pending operator awaiting its next char.
  if (state.viPending !== null) {
    return continueViPending(state, ev);
  }

  switch (ev.key) {
    case 'enter':
      return { kind: 'submit' };

    case 'tab':
      // No completion in normal mode (matches vim/readline-vi).
      return { kind: 'bell' };

    case 'escape':
      // Already normal; clear any half-formed operator.
      state.viPending = null;
      return { kind: 'noop' };

    case 'backspace':
      // In normal mode bare backspace is "move left" per readline-vi.
      state.buffer.moveLeft();
      return { kind: 'redraw' };

    case 'delete':
      state.buffer.deleteRight();
      return { kind: 'redraw' };

    case 'left':
      state.buffer.moveLeft();
      return { kind: 'redraw' };

    case 'right':
      state.buffer.moveRight();
      return { kind: 'redraw' };

    case 'up':
      return navigateHistory(state, -1);

    case 'down':
      return navigateHistory(state, +1);

    case 'home':
      state.buffer.moveHome();
      return { kind: 'redraw' };

    case 'end':
      state.buffer.moveEnd();
      return { kind: 'redraw' };

    case 'char':
      return handleViNormalChar(state, ev);

    case 'paste-start':
      state.pasting = true;
      return { kind: 'paste-start' };

    case 'paste-end':
      state.pasting = false;
      return { kind: 'paste-end' };

    case 'pageup':
    case 'pagedown':
    case 'unknown':
      return { kind: 'bell' };
  }
};

const handleViNormalChar = (state: EditorState, ev: KeyEvent): EditorAction => {
  const ch = ev.char ?? '';
  if (ch.length === 0) return { kind: 'noop' };

  // ^D on empty buffer is EOF in vi normal mode too.
  if (ev.ctrl && ch === 'd' && state.buffer.length === 0) {
    return { kind: 'eof' };
  }
  // Other ctrl/meta sequences: not bound in normal mode → bell.
  if (ev.ctrl || ev.meta) return { kind: 'bell' };

  switch (ch) {
    // Movement
    case 'h':
      state.buffer.moveLeft();
      return { kind: 'redraw' };
    case 'l':
      state.buffer.moveRight();
      return { kind: 'redraw' };
    case 'b':
      state.buffer.moveWordLeft();
      return { kind: 'redraw' };
    case 'w':
      state.buffer.moveWordRight();
      return { kind: 'redraw' };
    case 'e':
      viMoveEndOfWord(state.buffer);
      return { kind: 'redraw' };
    case '0':
      state.buffer.moveHome();
      return { kind: 'redraw' };
    case '$':
      state.buffer.moveEnd();
      return { kind: 'redraw' };
    case '^':
      viMoveFirstNonBlank(state.buffer);
      return { kind: 'redraw' };

    // History (vi-style j/k).
    case 'j':
      return navigateHistory(state, +1);
    case 'k':
      return navigateHistory(state, -1);

    // Mode switches.
    case 'i':
      state.mode = 'insert';
      return { kind: 'redraw' };
    case 'a':
      if (state.buffer.cursor < state.buffer.length) state.buffer.moveRight();
      state.mode = 'insert';
      return { kind: 'redraw' };
    case 'I':
      state.buffer.moveHome();
      state.mode = 'insert';
      return { kind: 'redraw' };
    case 'A':
      state.buffer.moveEnd();
      state.mode = 'insert';
      return { kind: 'redraw' };

    // Edits.
    case 'x':
      state.buffer.deleteRight();
      return { kind: 'redraw' };
    case 'X':
      state.buffer.deleteLeft();
      return { kind: 'redraw' };
    case 'D':
      state.buffer.killToEnd();
      return { kind: 'redraw' };
    case '~':
      viToggleCaseAtCursor(state.buffer);
      return { kind: 'redraw' };

    // Multi-key operators: wait for next char.
    case 'r':
      state.viPending = 'r';
      return { kind: 'noop' };
    case 'd':
      state.viPending = 'd';
      return { kind: 'noop' };
    case 'c':
      state.viPending = 'c';
      return { kind: 'noop' };
    case 'g':
      // Stub: only 'gg' (go to first history) might be desirable; for now,
      // just consume the prefix and bell on the follow-up.
      state.viPending = 'g';
      return { kind: 'noop' };

    case ':':
      // Stretch goal — stubbed out; ring the bell so the user knows.
      return { kind: 'bell' };

    default:
      return { kind: 'bell' };
  }
};

/**
 * Resolve a pending vi operator using the next key event. `r<char>` replaces
 * one char; `dd` / `cc` operate on the whole line; `dw` / `cw` operate on a
 * word; anything else bells.
 */
const continueViPending = (state: EditorState, ev: KeyEvent): EditorAction => {
  const pending = state.viPending;
  state.viPending = null;

  // Escape cancels a pending operator without bell (matches vi convention).
  if (ev.key === 'escape') return { kind: 'noop' };

  if (pending === 'r') {
    // r<char> replaces one char at cursor with <char>.
    if (ev.key !== 'char' || ev.char === undefined || ev.ctrl || ev.meta) {
      return { kind: 'bell' };
    }
    if (state.buffer.cursor >= state.buffer.length) return { kind: 'bell' };
    viReplaceCharAtCursor(state.buffer, ev.char);
    return { kind: 'redraw' };
  }

  if (pending === 'g') {
    // Only 'gg' is recognised; we don't actually implement first-history yet.
    return { kind: 'bell' };
  }

  // dd / cc / dw / cw all key off ev.char.
  if (ev.key !== 'char' || ev.char === undefined || ev.ctrl || ev.meta) {
    return { kind: 'bell' };
  }
  const c = ev.char;

  if (pending === 'd') {
    if (c === 'd') {
      // dd: kill whole line.
      state.buffer.moveHome();
      state.buffer.killToEnd();
      return { kind: 'redraw' };
    }
    if (c === 'w') {
      state.buffer.killWordRight();
      return { kind: 'redraw' };
    }
    if (c === 'b') {
      state.buffer.killWordLeft();
      return { kind: 'redraw' };
    }
    if (c === '$') {
      state.buffer.killToEnd();
      return { kind: 'redraw' };
    }
    if (c === '0') {
      state.buffer.killToStart();
      return { kind: 'redraw' };
    }
    return { kind: 'bell' };
  }

  if (pending === 'c') {
    if (c === 'c') {
      // cc: kill whole line, enter insert.
      state.buffer.moveHome();
      state.buffer.killToEnd();
      state.mode = 'insert';
      return { kind: 'redraw' };
    }
    if (c === 'w') {
      state.buffer.killWordRight();
      state.mode = 'insert';
      return { kind: 'redraw' };
    }
    if (c === 'b') {
      state.buffer.killWordLeft();
      state.mode = 'insert';
      return { kind: 'redraw' };
    }
    if (c === '$') {
      state.buffer.killToEnd();
      state.mode = 'insert';
      return { kind: 'redraw' };
    }
    if (c === '0') {
      state.buffer.killToStart();
      state.mode = 'insert';
      return { kind: 'redraw' };
    }
    return { kind: 'bell' };
  }

  return { kind: 'bell' };
};

/** `e` motion: jump to the end of the current word (or the next word). */
const viMoveEndOfWord = (buf: LineBuffer): void => {
  const text = buf.text;
  const cps = Array.from(text);
  let i = buf.cursor;
  // If we're between/inside a word, move to the last char of the word that
  // ends at or after cursor.
  // Step 1: if cursor is at a non-word, skip to the next word's first char.
  while (i < cps.length && !isWordChar(cps[i])) i++;
  // Step 2: if we landed inside a word, advance to its last char (one before
  // the next non-word boundary).
  while (i < cps.length - 1 && isWordChar(cps[i + 1])) i++;
  // Vi's `e` leaves the cursor ON the last char, not past it. Our buffer uses
  // cursor "between code points", so put it after that last char.
  if (i < cps.length) i++;
  buf.setText(text, i);
};

/** `^` motion: first non-blank char on the line. */
const viMoveFirstNonBlank = (buf: LineBuffer): void => {
  const text = buf.text;
  const cps = Array.from(text);
  let i = 0;
  while (i < cps.length && (cps[i] === ' ' || cps[i] === '\t')) i++;
  buf.setText(text, i);
};

/** `~` toggles the case of the character at the cursor; advances cursor. */
const viToggleCaseAtCursor = (buf: LineBuffer): void => {
  const text = buf.text;
  const cps = Array.from(text);
  const i = buf.cursor;
  if (i >= cps.length) return;
  const ch = cps[i];
  const flipped = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
  if (flipped === ch) {
    // Non-alpha: just advance.
    buf.setText(text, Math.min(i + 1, cps.length));
    return;
  }
  buf.pushUndo();
  cps[i] = flipped;
  buf.setText(cps.join(''), Math.min(i + 1, cps.length));
};

/** `r<char>` replaces the character at cursor and leaves cursor in place. */
const viReplaceCharAtCursor = (buf: LineBuffer, ch: string): void => {
  const text = buf.text;
  const cps = Array.from(text);
  const i = buf.cursor;
  if (i >= cps.length) return;
  buf.pushUndo();
  cps[i] = ch;
  buf.setText(cps.join(''), i);
};

// Re-export for vi helpers that need word classification (matches buffer.ts).
const isWordChar = (ch: string): boolean => {
  if (ch.length === 0) return false;
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x30 && cp <= 0x39) return true; // 0-9
  if (cp >= 0x41 && cp <= 0x5a) return true; // A-Z
  if (cp >= 0x61 && cp <= 0x7a) return true; // a-z
  if (cp === 0x5f) return true; // _
  if (cp > 0x7f) return cp >= 0xa0;
  return false;
};

/** ^T: swap the character before the cursor with the one before it. */
const transpose = (buf: LineBuffer): void => {
  const len = buf.length;
  if (len < 2) return;
  const text = buf.text;
  const cps = Array.from(text);
  let i = buf.cursor;
  if (i === 0) return;
  if (i === len) i--; // at EOL: act on the last two chars
  if (i < 1) return;
  buf.pushUndo();
  const tmp = cps[i - 1];
  cps[i - 1] = cps[i];
  cps[i] = tmp;
  buf.setText(cps.join(''), Math.min(i + 1, len));
};
