import { describe, it, expect } from 'vitest';

import { dispatch, makeState } from './keymap.js';
import type { KeyEvent } from './vt100.js';

const press = (
  key: KeyEvent['key'],
  extra: Partial<KeyEvent> = {},
): KeyEvent => ({ key, ...extra });

const ctrl = (ch: string): KeyEvent => ({ key: 'char', char: ch, ctrl: true });
const meta = (ch: string): KeyEvent => ({ key: 'char', char: ch, meta: true });
const printable = (ch: string): KeyEvent => ({ key: 'char', char: ch });

describe('keymap dispatch', () => {
  describe('printable insertion', () => {
    it('inserts characters', () => {
      const s = makeState();
      dispatch(s, printable('h'));
      dispatch(s, printable('i'));
      expect(s.buffer.text).toBe('hi');
    });

    it('returns redraw action for printable', () => {
      const s = makeState();
      const a = dispatch(s, printable('x'));
      expect(a.kind).toBe('redraw');
    });
  });

  describe('control keys', () => {
    it('^A moves to start, ^E to end', () => {
      const s = makeState();
      s.buffer.setText('hello');
      dispatch(s, ctrl('a'));
      expect(s.buffer.cursor).toBe(0);
      dispatch(s, ctrl('e'));
      expect(s.buffer.cursor).toBe(5);
    });

    it('^B / ^F step cursor', () => {
      const s = makeState();
      s.buffer.setText('ab', 2);
      dispatch(s, ctrl('b'));
      expect(s.buffer.cursor).toBe(1);
      dispatch(s, ctrl('f'));
      expect(s.buffer.cursor).toBe(2);
    });

    it('^K kills to end', () => {
      const s = makeState();
      s.buffer.setText('hello world', 5);
      dispatch(s, ctrl('k'));
      expect(s.buffer.text).toBe('hello');
    });

    it('^U kills to start', () => {
      const s = makeState();
      s.buffer.setText('hello', 3);
      dispatch(s, ctrl('u'));
      expect(s.buffer.text).toBe('lo');
    });

    it('^W kills previous word', () => {
      const s = makeState();
      s.buffer.setText('foo bar', 7);
      dispatch(s, ctrl('w'));
      expect(s.buffer.text).toBe('foo ');
    });

    it('^Y yanks last kill', () => {
      const s = makeState();
      s.buffer.setText('hello', 5);
      dispatch(s, ctrl('u'));
      expect(s.buffer.text).toBe('');
      dispatch(s, ctrl('y'));
      expect(s.buffer.text).toBe('hello');
    });

    it('^D on empty buffer returns eof', () => {
      const s = makeState();
      const a = dispatch(s, ctrl('d'));
      expect(a.kind).toBe('eof');
    });

    it('^D on non-empty deletes forward', () => {
      const s = makeState();
      s.buffer.setText('abc', 0);
      const a = dispatch(s, ctrl('d'));
      expect(a.kind).toBe('redraw');
      expect(s.buffer.text).toBe('bc');
    });

    it('^C returns cancel', () => {
      const s = makeState();
      const a = dispatch(s, ctrl('c'));
      expect(a.kind).toBe('cancel');
    });

    it('^L returns clear-screen', () => {
      const s = makeState();
      const a = dispatch(s, ctrl('l'));
      expect(a.kind).toBe('clear-screen');
    });

    it('^R returns search-start', () => {
      const s = makeState();
      const a = dispatch(s, ctrl('r'));
      expect(a.kind).toBe('search-start');
    });

    it('^T transposes characters', () => {
      const s = makeState();
      s.buffer.setText('ab', 2);
      dispatch(s, ctrl('t'));
      expect(s.buffer.text).toBe('ba');
    });

    it('^_ undoes', () => {
      const s = makeState();
      dispatch(s, printable('a'));
      dispatch(s, printable('b'));
      expect(s.buffer.text).toBe('ab');
      dispatch(s, ctrl('_'));
      expect(s.buffer.text).toBe('a');
    });
  });

  describe('meta keys', () => {
    it('M-b moves word left', () => {
      const s = makeState();
      s.buffer.setText('foo bar', 7);
      dispatch(s, meta('b'));
      expect(s.buffer.cursor).toBe(4);
    });

    it('M-f moves word right', () => {
      const s = makeState();
      s.buffer.setText('foo bar', 0);
      dispatch(s, meta('f'));
      expect(s.buffer.cursor).toBe(3);
    });

    it('M-d kills word forward', () => {
      const s = makeState();
      s.buffer.setText('foo bar', 0);
      dispatch(s, meta('d'));
      expect(s.buffer.text).toBe(' bar');
    });
  });

  describe('history', () => {
    it('Up walks back through history', () => {
      const s = makeState(['first', 'second']);
      dispatch(s, press('up'));
      expect(s.buffer.text).toBe('second');
      dispatch(s, press('up'));
      expect(s.buffer.text).toBe('first');
    });

    it('Down restores live line', () => {
      const s = makeState(['one']);
      s.buffer.setText('live');
      dispatch(s, press('up'));
      expect(s.buffer.text).toBe('one');
      dispatch(s, press('down'));
      expect(s.buffer.text).toBe('live');
    });

    it('bells when history is empty', () => {
      const s = makeState([]);
      const a = dispatch(s, press('up'));
      expect(a.kind).toBe('bell');
    });
  });

  describe('arrow keys', () => {
    it('left and right step', () => {
      const s = makeState();
      s.buffer.setText('hi', 2);
      dispatch(s, press('left'));
      expect(s.buffer.cursor).toBe(1);
      dispatch(s, press('right'));
      expect(s.buffer.cursor).toBe(2);
    });

    it('Home and End', () => {
      const s = makeState();
      s.buffer.setText('hello', 3);
      dispatch(s, press('home'));
      expect(s.buffer.cursor).toBe(0);
      dispatch(s, press('end'));
      expect(s.buffer.cursor).toBe(5);
    });

    it('Alt-arrow does word motion', () => {
      const s = makeState();
      s.buffer.setText('foo bar', 7);
      dispatch(s, press('left', { meta: true }));
      expect(s.buffer.cursor).toBe(4);
    });
  });

  describe('submit / tab', () => {
    it('enter returns submit', () => {
      const s = makeState();
      s.buffer.setText('abc');
      const a = dispatch(s, press('enter'));
      expect(a.kind).toBe('submit');
    });

    it('tab returns complete', () => {
      const s = makeState();
      const a = dispatch(s, press('tab'));
      expect(a.kind).toBe('complete');
    });
  });

  describe('bracketed paste', () => {
    it('toggles paste state and inserts literally', () => {
      const s = makeState();
      dispatch(s, press('paste-start'));
      expect(s.pasting).toBe(true);
      dispatch(s, printable('a'));
      dispatch(s, press('enter')); // becomes literal newline
      dispatch(s, printable('b'));
      dispatch(s, press('paste-end'));
      expect(s.pasting).toBe(false);
      expect(s.buffer.text).toBe('a\nb');
    });
  });
});

describe('vi mode dispatch', () => {
  const viState = (): ReturnType<typeof makeState> => makeState([], 'insert');

  describe('mode transitions', () => {
    it('starts in insert mode when constructed with insert', () => {
      const s = viState();
      expect(s.mode).toBe('insert');
    });

    it('Esc switches from insert to normal', () => {
      const s = viState();
      dispatch(s, printable('a'));
      dispatch(s, printable('b'));
      expect(s.mode).toBe('insert');
      dispatch(s, press('escape'));
      expect(s.mode).toBe('normal');
      // Esc convention: cursor steps left onto last inserted char.
      expect(s.buffer.cursor).toBe(1);
    });

    it('printable in insert inserts the char', () => {
      const s = viState();
      dispatch(s, printable('h'));
      dispatch(s, printable('i'));
      expect(s.buffer.text).toBe('hi');
      expect(s.mode).toBe('insert');
    });

    it('i in normal switches back to insert', () => {
      const s = viState();
      dispatch(s, printable('a'));
      dispatch(s, press('escape'));
      expect(s.mode).toBe('normal');
      dispatch(s, printable('i'));
      expect(s.mode).toBe('insert');
    });

    it('a in normal moves right then enters insert', () => {
      const s = viState();
      dispatch(s, printable('a'));
      dispatch(s, printable('b'));
      // cursor=2, esc → cursor=1, mode=normal
      dispatch(s, press('escape'));
      expect(s.buffer.cursor).toBe(1);
      dispatch(s, printable('a'));
      expect(s.mode).toBe('insert');
      expect(s.buffer.cursor).toBe(2);
    });

    it('I jumps to line start in insert', () => {
      const s = viState();
      dispatch(s, printable('h'));
      dispatch(s, printable('i'));
      dispatch(s, press('escape'));
      dispatch(s, printable('I'));
      expect(s.mode).toBe('insert');
      expect(s.buffer.cursor).toBe(0);
    });

    it('A jumps to line end in insert', () => {
      const s = viState();
      dispatch(s, printable('h'));
      dispatch(s, printable('i'));
      dispatch(s, press('escape'));
      dispatch(s, printable('0')); // go to start
      dispatch(s, printable('A'));
      expect(s.mode).toBe('insert');
      expect(s.buffer.cursor).toBe(2);
    });
  });

  describe('normal-mode movement', () => {
    it('h and l move left and right', () => {
      const s = viState();
      s.buffer.setText('abc', 3);
      s.mode = 'normal';
      dispatch(s, printable('h'));
      expect(s.buffer.cursor).toBe(2);
      dispatch(s, printable('h'));
      expect(s.buffer.cursor).toBe(1);
      dispatch(s, printable('l'));
      expect(s.buffer.cursor).toBe(2);
    });

    it('w moves word right, b moves word left', () => {
      const s = viState();
      s.buffer.setText('foo bar baz', 0);
      s.mode = 'normal';
      dispatch(s, printable('w'));
      expect(s.buffer.text.slice(0, s.buffer.cursor)).toBe('foo');
      dispatch(s, printable('w'));
      expect(s.buffer.text.slice(0, s.buffer.cursor)).toBe('foo bar');
      dispatch(s, printable('b'));
      expect(s.buffer.text.slice(0, s.buffer.cursor)).toBe('foo ');
    });

    it('0 and $ jump to line bounds', () => {
      const s = viState();
      s.buffer.setText('hello', 2);
      s.mode = 'normal';
      dispatch(s, printable('0'));
      expect(s.buffer.cursor).toBe(0);
      dispatch(s, printable('$'));
      expect(s.buffer.cursor).toBe(5);
    });

    it('^ jumps to first non-blank', () => {
      const s = viState();
      s.buffer.setText('   abc', 5);
      s.mode = 'normal';
      dispatch(s, printable('^'));
      expect(s.buffer.cursor).toBe(3);
    });
  });

  describe('normal-mode edits', () => {
    it('x deletes the char at cursor', () => {
      const s = viState();
      s.buffer.setText('abc', 0);
      s.mode = 'normal';
      dispatch(s, printable('x'));
      expect(s.buffer.text).toBe('bc');
    });

    it('X deletes the char to the left', () => {
      const s = viState();
      s.buffer.setText('abc', 2);
      s.mode = 'normal';
      dispatch(s, printable('X'));
      expect(s.buffer.text).toBe('ac');
    });

    it('dd kills the whole line', () => {
      const s = viState();
      s.buffer.setText('hello world', 5);
      s.mode = 'normal';
      dispatch(s, printable('d'));
      dispatch(s, printable('d'));
      expect(s.buffer.text).toBe('');
    });

    it('D kills to end of line', () => {
      const s = viState();
      s.buffer.setText('hello world', 5);
      s.mode = 'normal';
      dispatch(s, printable('D'));
      expect(s.buffer.text).toBe('hello');
    });

    it('cc kills line and enters insert', () => {
      const s = viState();
      s.buffer.setText('hello', 3);
      s.mode = 'normal';
      dispatch(s, printable('c'));
      dispatch(s, printable('c'));
      expect(s.buffer.text).toBe('');
      expect(s.mode).toBe('insert');
    });

    it('cw changes a word and enters insert', () => {
      const s = viState();
      s.buffer.setText('foo bar', 0);
      s.mode = 'normal';
      dispatch(s, printable('c'));
      dispatch(s, printable('w'));
      expect(s.buffer.text).toBe(' bar');
      expect(s.mode).toBe('insert');
    });

    it('r<char> replaces a single character', () => {
      const s = viState();
      s.buffer.setText('abc', 1);
      s.mode = 'normal';
      dispatch(s, printable('r'));
      dispatch(s, printable('X'));
      expect(s.buffer.text).toBe('aXc');
      // Mode stays normal after r.
      expect(s.mode).toBe('normal');
    });

    it('~ toggles case of char at cursor', () => {
      const s = viState();
      s.buffer.setText('abc', 0);
      s.mode = 'normal';
      dispatch(s, printable('~'));
      expect(s.buffer.text).toBe('Abc');
      expect(s.buffer.cursor).toBe(1);
    });
  });

  describe('normal-mode history', () => {
    it('j and k step history forward and back', () => {
      const s = makeState(['first', 'second'], 'insert');
      s.mode = 'normal';
      dispatch(s, printable('k'));
      expect(s.buffer.text).toBe('second');
      dispatch(s, printable('k'));
      expect(s.buffer.text).toBe('first');
      dispatch(s, printable('j'));
      expect(s.buffer.text).toBe('second');
    });
  });

  describe('cancel works in either mode', () => {
    it('^C cancels in insert mode', () => {
      const s = viState();
      const a = dispatch(s, ctrl('c'));
      expect(a.kind).toBe('cancel');
    });

    it('^C cancels in normal mode', () => {
      const s = viState();
      s.mode = 'normal';
      const a = dispatch(s, ctrl('c'));
      expect(a.kind).toBe('cancel');
    });
  });

  describe('emacs mode is unaffected by vi additions', () => {
    it('default mode is emacs', () => {
      const s = makeState();
      expect(s.mode).toBe('emacs');
    });

    it('Esc in emacs mode is a noop, not a mode switch', () => {
      const s = makeState();
      s.buffer.setText('abc', 3);
      const a = dispatch(s, press('escape'));
      expect(a.kind).toBe('noop');
      expect(s.mode).toBe('emacs');
    });
  });

  describe('ex-prompt mode (`:`-commands)', () => {
    const viNormal = (): ReturnType<typeof makeState> => {
      const s = makeState([], 'insert');
      s.mode = 'normal';
      return s;
    };

    it('`:` from normal mode enters ex with empty buffer', () => {
      const s = viNormal();
      const a = dispatch(s, printable(':'));
      expect(s.mode).toBe('ex');
      expect(s.exBuffer).toBe('');
      expect(a.kind).toBe('ex-update');
    });

    it('printable chars accumulate in exBuffer', () => {
      const s = viNormal();
      dispatch(s, printable(':'));
      dispatch(s, printable('q'));
      expect(s.mode).toBe('ex');
      expect(s.exBuffer).toBe('q');
      const a = dispatch(s, printable('u'));
      expect(s.exBuffer).toBe('qu');
      expect(a.kind).toBe('ex-update');
    });

    it('Esc aborts ex and returns to normal mode (empty buffer)', () => {
      const s = viNormal();
      dispatch(s, printable(':'));
      dispatch(s, printable('q'));
      const a = dispatch(s, press('escape'));
      expect(a.kind).toBe('redraw');
      expect(s.mode).toBe('normal');
      expect(s.exBuffer).toBe('');
    });

    it('`:q` Enter cancels the readLine', () => {
      const s = viNormal();
      dispatch(s, printable(':'));
      dispatch(s, printable('q'));
      const a = dispatch(s, press('enter'));
      expect(a.kind).toBe('cancel');
      // After cancel the state still flips back to normal + empty exBuffer.
      expect(s.mode).toBe('normal');
      expect(s.exBuffer).toBe('');
    });

    it('`:quit` Enter cancels the readLine', () => {
      const s = viNormal();
      dispatch(s, printable(':'));
      for (const c of 'quit') dispatch(s, printable(c));
      const a = dispatch(s, press('enter'));
      expect(a.kind).toBe('cancel');
    });

    it('`:q!` Enter cancels the readLine', () => {
      const s = viNormal();
      dispatch(s, printable(':'));
      dispatch(s, printable('q'));
      dispatch(s, printable('!'));
      const a = dispatch(s, press('enter'));
      expect(a.kind).toBe('cancel');
    });

    it('`:w` Enter bells (we have no file to write)', () => {
      const s = viNormal();
      dispatch(s, printable(':'));
      dispatch(s, printable('w'));
      const a = dispatch(s, press('enter'));
      expect(a.kind).toBe('bell');
      // And falls back to normal mode.
      expect(s.mode).toBe('normal');
      expect(s.exBuffer).toBe('');
    });

    it('unknown command + Enter bells and returns to normal', () => {
      const s = viNormal();
      dispatch(s, printable(':'));
      dispatch(s, printable('z'));
      const a = dispatch(s, press('enter'));
      expect(a.kind).toBe('bell');
      expect(s.mode).toBe('normal');
    });

    it('Backspace shrinks the ex buffer', () => {
      const s = viNormal();
      dispatch(s, printable(':'));
      dispatch(s, printable('q'));
      dispatch(s, printable('u'));
      const a = dispatch(s, press('backspace'));
      expect(a.kind).toBe('ex-update');
      expect(s.exBuffer).toBe('q');
    });

    it('Backspace at empty exBuffer returns to normal', () => {
      const s = viNormal();
      dispatch(s, printable(':'));
      const a = dispatch(s, press('backspace'));
      expect(a.kind).toBe('redraw');
      expect(s.mode).toBe('normal');
    });

    it('^C in ex mode cancels (handled at top-level dispatch)', () => {
      const s = viNormal();
      dispatch(s, printable(':'));
      dispatch(s, printable('q'));
      const a = dispatch(s, ctrl('c'));
      expect(a.kind).toBe('cancel');
    });

    it('bare `:` then Enter returns to normal silently', () => {
      const s = viNormal();
      dispatch(s, printable(':'));
      const a = dispatch(s, press('enter'));
      expect(a.kind).toBe('redraw');
      expect(s.mode).toBe('normal');
    });
  });
});
