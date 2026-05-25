/**
 * Pure line-buffer state for the psql line editor.
 *
 * We avoid an actual gap buffer because edited lines are short (~100 chars
 * typical, a few KB worst case for pasted SQL) and JavaScript string
 * concatenation is fast enough at that scale. The "buffer-ish" API still
 * exposes insert/delete-at-cursor primitives so callers stay code-point
 * aware rather than byte aware.
 *
 * Everything in this module operates on Unicode *code points*. Internally
 * we store the line as an array of code-point strings (each element is one
 * scalar value, typically one UTF-16 code unit but two for astral chars).
 * The `cursor` is an index into that array, in the range `[0, length]`.
 *
 * Editing primitives mutate the state in place and push the previous
 * snapshot onto the undo stack. Killed text (^K, ^U, ^W) is appended to
 * the most recent kill ring entry when killing continues in the same
 * direction; yank pulls from the most recent entry.
 *
 * No I/O, no rendering, no terminal awareness — that lives in
 * `keymap.ts` / `index.ts`. Tests cover this module exhaustively.
 */

export type KillDirection = 'forward' | 'backward' | 'none';

export type LineBufferSnapshot = {
  text: string;
  cursor: number;
};

/**
 * Encode a string as an array of code-point characters. Each element is
 * one Unicode scalar (`"A"`, `"é"`, `"\u{1F600}"`). This lets cursor
 * arithmetic stay code-point-aligned without dealing with surrogate pairs
 * at every callsite.
 */
const toCodePoints = (s: string): string[] => Array.from(s);

/**
 * Pure line buffer plus kill ring plus undo. Used by the keymap layer.
 */
export class LineBuffer {
  /** One code point per element. */
  private chars: string[] = [];
  /** Code-point index in `[0, chars.length]`. */
  private _cursor = 0;
  /** Most-recent-first ring of killed text. Bounded to keep memory sane. */
  private killRing: string[] = [];
  /** Index into killRing for the next yank-pop (^Y / Alt-Y). */
  private yankIndex = -1;
  /** Direction of the previous kill so consecutive kills concatenate. */
  private lastKill: KillDirection = 'none';
  /** Snapshots for ^_ / undo. */
  private undoStack: LineBufferSnapshot[] = [];

  static readonly KILL_RING_MAX = 32;
  static readonly UNDO_STACK_MAX = 256;

  constructor(initial = '', cursor?: number) {
    this.chars = toCodePoints(initial);
    this._cursor =
      cursor === undefined ? this.chars.length : this.clampCursor(cursor);
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  get text(): string {
    return this.chars.join('');
  }

  get cursor(): number {
    return this._cursor;
  }

  get length(): number {
    return this.chars.length;
  }

  snapshot(): LineBufferSnapshot {
    return { text: this.text, cursor: this._cursor };
  }

  restore(snap: LineBufferSnapshot): void {
    this.chars = toCodePoints(snap.text);
    this._cursor = this.clampCursor(snap.cursor);
    this.lastKill = 'none';
  }

  /**
   * Replace the entire buffer in one go. Used when navigating history or
   * accepting a completion. Does NOT push an undo entry on its own — call
   * `pushUndo()` first if you want to record the previous state.
   */
  setText(text: string, cursor?: number): void {
    this.chars = toCodePoints(text);
    this._cursor =
      cursor === undefined ? this.chars.length : this.clampCursor(cursor);
    this.lastKill = 'none';
  }

  // -------------------------------------------------------------------------
  // Cursor movement (all in code points, never bytes / UTF-16 units)
  // -------------------------------------------------------------------------

  moveLeft(): void {
    if (this._cursor > 0) this._cursor--;
    this.lastKill = 'none';
  }

  moveRight(): void {
    if (this._cursor < this.chars.length) this._cursor++;
    this.lastKill = 'none';
  }

  moveHome(): void {
    this._cursor = 0;
    this.lastKill = 'none';
  }

  moveEnd(): void {
    this._cursor = this.chars.length;
    this.lastKill = 'none';
  }

  /**
   * Move left over one word. Word ≙ run of alphanumerics. Skip the
   * non-alphanumerics immediately to the left first (matches readline's
   * `M-b`). Pure stdlib `\w` is locale-sensitive in some runtimes; we
   * use a `RegExp` against the actual code-point string.
   */
  moveWordLeft(): void {
    let i = this._cursor;
    while (i > 0 && !isWordChar(this.chars[i - 1])) i--;
    while (i > 0 && isWordChar(this.chars[i - 1])) i--;
    this._cursor = i;
    this.lastKill = 'none';
  }

  moveWordRight(): void {
    let i = this._cursor;
    while (i < this.chars.length && !isWordChar(this.chars[i])) i++;
    while (i < this.chars.length && isWordChar(this.chars[i])) i++;
    this._cursor = i;
    this.lastKill = 'none';
  }

  // -------------------------------------------------------------------------
  // Insertion / deletion
  // -------------------------------------------------------------------------

  /** Insert a string at the cursor (split into code points first). */
  insert(s: string): void {
    if (s.length === 0) return;
    this.pushUndo();
    const cps = toCodePoints(s);
    this.chars.splice(this._cursor, 0, ...cps);
    this._cursor += cps.length;
    this.lastKill = 'none';
  }

  /** Backspace: delete the code point to the left of cursor. */
  deleteLeft(): void {
    if (this._cursor === 0) return;
    this.pushUndo();
    this.chars.splice(this._cursor - 1, 1);
    this._cursor--;
    this.lastKill = 'none';
  }

  /** Delete the code point to the right of cursor. */
  deleteRight(): void {
    if (this._cursor === this.chars.length) return;
    this.pushUndo();
    this.chars.splice(this._cursor, 1);
    this.lastKill = 'none';
  }

  // -------------------------------------------------------------------------
  // Kill ring operations
  // -------------------------------------------------------------------------

  /** ^K: kill from cursor to end-of-line. Appends if previous kill was forward. */
  killToEnd(): void {
    if (this._cursor === this.chars.length) return;
    this.pushUndo();
    const killed = this.chars.slice(this._cursor).join('');
    this.chars.length = this._cursor;
    this.recordKill(killed, 'forward');
  }

  /** ^U: kill from start-of-line to cursor. */
  killToStart(): void {
    if (this._cursor === 0) return;
    this.pushUndo();
    const killed = this.chars.slice(0, this._cursor).join('');
    this.chars.splice(0, this._cursor);
    this._cursor = 0;
    this.recordKill(killed, 'backward');
  }

  /** ^W: kill the word (backward) to the left of cursor. */
  killWordLeft(): void {
    if (this._cursor === 0) return;
    let i = this._cursor;
    while (i > 0 && !isWordChar(this.chars[i - 1])) i--;
    while (i > 0 && isWordChar(this.chars[i - 1])) i--;
    if (i === this._cursor) return;
    this.pushUndo();
    const killed = this.chars.slice(i, this._cursor).join('');
    this.chars.splice(i, this._cursor - i);
    this._cursor = i;
    this.recordKill(killed, 'backward');
  }

  /** M-d: kill the word (forward) starting at cursor. */
  killWordRight(): void {
    if (this._cursor === this.chars.length) return;
    let i = this._cursor;
    while (i < this.chars.length && !isWordChar(this.chars[i])) i++;
    while (i < this.chars.length && isWordChar(this.chars[i])) i++;
    if (i === this._cursor) return;
    this.pushUndo();
    const killed = this.chars.slice(this._cursor, i).join('');
    this.chars.splice(this._cursor, i - this._cursor);
    this.recordKill(killed, 'forward');
  }

  /** ^Y: yank most recent kill at cursor. No-op if ring is empty. */
  yank(): string | undefined {
    if (this.killRing.length === 0) return undefined;
    const top = this.killRing[0];
    this.insert(top);
    this.yankIndex = 0;
    return top;
  }

  /**
   * M-y: rotate yank ring. Caller must have just yanked. Removes the
   * previously yanked text and inserts the next entry from the ring.
   */
  yankPop(prevYank: string): string | undefined {
    if (this.killRing.length === 0) return undefined;
    this.yankIndex = (this.yankIndex + 1) % this.killRing.length;
    if (this._cursor < prevYank.length) return undefined;
    const start = this._cursor - toCodePoints(prevYank).length;
    this.pushUndo();
    this.chars.splice(start, toCodePoints(prevYank).length);
    this._cursor = start;
    const next = this.killRing[this.yankIndex];
    const cps = toCodePoints(next);
    this.chars.splice(this._cursor, 0, ...cps);
    this._cursor += cps.length;
    return next;
  }

  /** Reset the kill-merge tracker. Called when a non-kill action runs. */
  resetKillTracking(): void {
    this.lastKill = 'none';
  }

  /** Test helper / introspection. */
  getKillRing(): readonly string[] {
    return this.killRing;
  }

  // -------------------------------------------------------------------------
  // Undo
  // -------------------------------------------------------------------------

  /** Push the current state onto the undo stack. */
  pushUndo(): void {
    this.undoStack.push({ text: this.text, cursor: this._cursor });
    if (this.undoStack.length > LineBuffer.UNDO_STACK_MAX) {
      this.undoStack.shift();
    }
  }

  /** ^_: pop the most recent snapshot. Returns true if anything happened. */
  undo(): boolean {
    const snap = this.undoStack.pop();
    if (!snap) return false;
    this.chars = toCodePoints(snap.text);
    this._cursor = this.clampCursor(snap.cursor);
    this.lastKill = 'none';
    return true;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private clampCursor(c: number): number {
    if (c < 0) return 0;
    if (c > this.chars.length) return this.chars.length;
    return c;
  }

  private recordKill(text: string, dir: KillDirection): void {
    if (text.length === 0) return;
    if (this.lastKill === dir && this.killRing.length > 0) {
      // Merge with the previous kill so consecutive ^K / ^W feel like one
      // logical kill in the yank ring.
      this.killRing[0] =
        dir === 'forward' ? this.killRing[0] + text : text + this.killRing[0];
    } else {
      this.killRing.unshift(text);
      if (this.killRing.length > LineBuffer.KILL_RING_MAX) {
        this.killRing.length = LineBuffer.KILL_RING_MAX;
      }
    }
    this.lastKill = dir;
    this.yankIndex = -1;
  }
}

/**
 * Word character classifier. Matches readline's default: ASCII alphanumeric
 * plus underscore. Non-ASCII letters are treated as word chars too so
 * "señor" moves as one word.
 */
const isWordChar = (ch: string): boolean => {
  if (ch.length === 0) return false;
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x30 && cp <= 0x39) return true; // 0-9
  if (cp >= 0x41 && cp <= 0x5a) return true; // A-Z
  if (cp >= 0x61 && cp <= 0x7a) return true; // a-z
  if (cp === 0x5f) return true; // _
  if (cp > 0x7f) {
    // Treat any non-ASCII printable as word-ish; cheap heuristic but
    // sufficient for editor word motion.
    return cp >= 0xa0;
  }
  return false;
};
