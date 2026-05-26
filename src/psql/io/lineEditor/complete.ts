/**
 * Tab-completion plumbing for the line editor.
 *
 * Holds the small bit of state that lives between consecutive Tab presses
 * (last completion result, cycle index, last-tab timestamp). The renderer
 * calls `apply` on each Tab; the function mutates the buffer in place and
 * returns a `CompletionStep` telling the driver whether to ring the bell,
 * insert text, or list candidates below the prompt.
 *
 * State machine:
 *
 *   - First Tab: ask the completer. If 0 candidates → `bell`. If 1, insert
 *     it. If >1, insert the common prefix (if any) and remember the result.
 *   - Second Tab within DOUBLE_TAP_MS: emit a `list` action so the driver
 *     prints the candidates below the prompt.
 *   - Third Tab and onward: cycle through candidates. The previously
 *     inserted candidate is removed before inserting the next.
 *
 * Any non-Tab keystroke (handled by the keymap) calls `reset()` to drop
 * the completion state.
 */

import type { LineBuffer } from './buffer.js';

export type CompletionResult = {
  candidates: string[];
  commonPrefix: string;
  replaceLength: number;
  /**
   * If true, no trailing space should be appended when the unique-candidate
   * path inserts the completion. Mirrors upstream readline's
   * `rl_completion_append_character = 0` convention, used for in-progress
   * completions like schema names that the user is expected to continue
   * typing through (e.g. `public.` → next Tab fetches relations).
   *
   * Default behaviour (when undefined / false) is to append a space, matching
   * `rl_completion_append_character` = ' '.
   */
  suppressTrailingSpace?: boolean;
};

export type Completer = (
  input: string,
  cursor: number,
) => Promise<CompletionResult> | CompletionResult;

export type CompletionStep =
  | { kind: 'bell' }
  | { kind: 'inserted' } // text was inserted; redraw
  | { kind: 'list'; candidates: string[] } // print listing under the line
  | { kind: 'cycled'; candidate: string }; // cycled to a new candidate

/** Threshold for "second Tab" detection. Roughly 500ms by spec. */
const DOUBLE_TAP_MS = 500;

export class CompletionState {
  /** Most recent completion result. Reset to null after non-Tab input. */
  private result: CompletionResult | null = null;
  /** When the previous tab fired. */
  private lastTapAt = 0;
  /** How many tabs in a row (the first tab inserts prefix; second lists). */
  private tabCount = 0;
  /**
   * When cycling, the index of the candidate currently inserted in the
   * buffer. -1 means "no candidate inserted yet (common prefix only)".
   */
  private cycleIndex = -1;
  /** Length (in code points) of the candidate currently inserted. */
  private cycleLen = 0;

  reset(): void {
    this.result = null;
    this.tabCount = 0;
    this.cycleIndex = -1;
    this.cycleLen = 0;
    this.lastTapAt = 0;
  }

  /**
   * Index of the candidate currently inserted in the buffer, or `-1` if no
   * specific candidate is active (e.g. the user has only seen the common
   * prefix). Used by the listing renderer to reverse-video the active
   * candidate while cycling.
   */
  getCycleIndex(): number {
    return this.cycleIndex;
  }

  /** Snapshot of the candidate list, for re-rendering during a cycle. */
  getCandidates(): readonly string[] {
    return this.result?.candidates ?? [];
  }

  async apply(
    buffer: LineBuffer,
    completer: Completer,
    now: number = Date.now(),
  ): Promise<CompletionStep> {
    const elapsed = now - this.lastTapAt;
    this.lastTapAt = now;

    if (this.result === null || elapsed > DOUBLE_TAP_MS * 4) {
      // Fresh start: ask the completer.
      const res = await Promise.resolve(completer(buffer.text, buffer.cursor));
      this.result = res;
      this.tabCount = 1;
      this.cycleIndex = -1;
      this.cycleLen = 0;

      if (res.candidates.length === 0) return { kind: 'bell' };
      if (res.candidates.length === 1) {
        // Mirror upstream readline: a unique completion gets a trailing space
        // (rl_completion_append_character defaults to ' ') unless the result
        // explicitly suppresses it (e.g. schema prefix `public.` that the user
        // is expected to continue typing through) or the candidate itself
        // already ends in a punctuator that shouldn't be followed by a space.
        const cand = res.candidates[0];
        const text = shouldAppendSpace(cand, res) ? cand + ' ' : cand;
        replaceBeforeCursor(buffer, res.replaceLength, text);
        this.reset();
        return { kind: 'inserted' };
      }

      // Multiple candidates: insert common prefix if it extends the input.
      const ext = res.commonPrefix.length - res.replaceLength;
      if (ext > 0) {
        replaceBeforeCursor(buffer, res.replaceLength, res.commonPrefix);
        // Update the "what's currently inserted" to the common prefix length.
        this.cycleLen = countCodePoints(res.commonPrefix);
      } else {
        this.cycleLen = countCodePoints(res.commonPrefix);
      }
      return { kind: 'inserted' };
    }

    // We already have a result, and the second Tab arrived in time.
    this.tabCount++;

    if (this.tabCount === 2 && elapsed <= DOUBLE_TAP_MS) {
      // List the candidates.
      return { kind: 'list', candidates: this.result.candidates.slice() };
    }

    // Third or later: cycle.
    const cands = this.result.candidates;
    this.cycleIndex = (this.cycleIndex + 1) % cands.length;
    const cand = cands[this.cycleIndex];
    replaceBeforeCursor(buffer, this.cycleLen, cand);
    this.cycleLen = countCodePoints(cand);
    return { kind: 'cycled', candidate: cand };
  }
}

/**
 * Replace `replaceLen` code points before cursor with `text`. The buffer
 * loses an undo entry per call; that's intentional so Ctrl-_ can undo a
 * mistaken completion.
 */
const replaceBeforeCursor = (
  buffer: LineBuffer,
  replaceLen: number,
  text: string,
): void => {
  // Move left over the bytes we're replacing, delete them, then insert.
  for (let i = 0; i < replaceLen; i++) buffer.deleteLeft();
  buffer.insert(text);
};

const countCodePoints = (s: string): number => Array.from(s).length;

/**
 * Decide whether to append a trailing space after a unique completion.
 * Mirrors upstream readline's `rl_completion_append_character` convention:
 * default is `' '`, but psql clears it for partial completions the user
 * is expected to continue typing (schema prefix, open-quoted identifier,
 * directory path).
 *
 * Rules:
 *   - If the result explicitly sets `suppressTrailingSpace: true`, don't.
 *   - Candidates already ending in whitespace are left untouched.
 *   - Candidates ending in `.`, `/`, `(` are "in progress" (schema
 *     namespace, path component, function open-paren) — no space.
 *   - Candidates ending in `'` or `"` get a space only when quote count
 *     is BALANCED (closed string / closed quoted identifier). An odd
 *     count means the user is still inside the quoted region.
 *   - Everything else gets a space.
 */
const shouldAppendSpace = (
  candidate: string,
  result: CompletionResult,
): boolean => {
  if (result.suppressTrailingSpace === true) return false;
  if (candidate.length === 0) return false;
  const last = candidate[candidate.length - 1];
  if (last === ' ' || last === '\t' || last === '\n') return false;
  if (last === '.' || last === '/' || last === '(') return false;
  if (last === '"') {
    // Even count means quotes are balanced (e.g. `"mixedName"`) — completed
    // identifier, append a space. Odd count means we're still inside an
    // open quote (e.g. `"foo`) — leave the user to type more.
    const count = countChar(candidate, '"');
    return count % 2 === 0;
  }
  if (last === "'") {
    const count = countChar(candidate, "'");
    return count % 2 === 0;
  }
  return true;
};

const countChar = (s: string, ch: string): number => {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
};

// ---------------------------------------------------------------------------
// Listing helper: format candidates in column layout for display.
// ---------------------------------------------------------------------------

/** ANSI reverse-video escape (SGR 7) used to mark the active candidate. */
const SGR_REVERSE = '\x1b[7m';
const SGR_NO_REVERSE = '\x1b[27m';

/**
 * Lay out candidates into a multi-column block. Returns the formatted
 * string (without a trailing newline — caller decides). Columns are sized
 * to fit `termWidth`; we use the longest candidate plus a 2-space gutter.
 *
 * Falls back to one-per-line if `termWidth` is too narrow.
 *
 * If `highlightIndex` is provided and points to a valid candidate, that
 * candidate is wrapped in `\x1b[7m...\x1b[27m` (reverse video) so the user
 * can see which entry is currently inserted in the line during a Tab cycle.
 * Out-of-range indices are silently ignored.
 */
export const formatCandidates = (
  candidates: readonly string[],
  termWidth: number,
  highlightIndex?: number,
): string => {
  if (candidates.length === 0) return '';
  const maxLen = candidates.reduce((m, c) => Math.max(m, c.length), 0);
  const colWidth = maxLen + 2;
  const cols = Math.max(1, Math.floor(termWidth / colWidth));
  const rows = Math.ceil(candidates.length / cols);
  const hl =
    highlightIndex !== undefined &&
    highlightIndex >= 0 &&
    highlightIndex < candidates.length
      ? highlightIndex
      : -1;
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const parts: string[] = [];
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (idx >= candidates.length) break;
      const cand = candidates[idx];
      const padded = cand + ' '.repeat(colWidth - cand.length);
      if (idx === hl) {
        // Wrap only the candidate text, not the gutter spaces, so adjacent
        // columns don't get a colored stripe between them.
        parts.push(
          SGR_REVERSE +
            cand +
            SGR_NO_REVERSE +
            ' '.repeat(colWidth - cand.length),
        );
      } else {
        parts.push(padded);
      }
    }
    lines.push(parts.join('').trimEnd());
  }
  return lines.join('\n');
};
