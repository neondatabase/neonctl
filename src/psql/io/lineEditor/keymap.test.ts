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
