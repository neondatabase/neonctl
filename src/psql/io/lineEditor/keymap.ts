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
};

export const makeState = (history: string[] = []): EditorState => ({
  buffer: new LineBuffer(),
  history: [...history],
  historyIndex: -1,
  liveSnapshot: null,
  lastYank: null,
  pasting: false,
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
