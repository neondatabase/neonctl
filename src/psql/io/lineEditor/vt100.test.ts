import { describe, it, expect } from 'vitest';

import { Vt100Decoder, type KeyEvent } from './vt100.js';

const bytes = (...nums: number[]): Uint8Array => Uint8Array.from(nums);
const ascii = (s: string): Uint8Array =>
  Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0)));

const consume = (input: Uint8Array): KeyEvent[] => {
  const d = new Vt100Decoder();
  return d.push(input);
};

describe('Vt100Decoder', () => {
  describe('printables and control codes', () => {
    it('emits one event per ASCII char', () => {
      const evs = consume(ascii('abc'));
      expect(evs.map((e) => e.char)).toEqual(['a', 'b', 'c']);
      expect(evs.every((e) => e.key === 'char')).toBe(true);
    });

    it('handles tab', () => {
      expect(consume(bytes(0x09))).toEqual([{ key: 'tab' }]);
    });

    it('handles enter (CR and LF)', () => {
      expect(consume(bytes(0x0a))).toEqual([{ key: 'enter' }]);
      expect(consume(bytes(0x0d))).toEqual([{ key: 'enter' }]);
    });

    it('treats DEL and BS as backspace', () => {
      expect(consume(bytes(0x7f))).toEqual([{ key: 'backspace' }]);
      expect(consume(bytes(0x08))).toEqual([{ key: 'backspace' }]);
    });

    it('emits ctrl chars for 0x01..0x1f', () => {
      const ctrlA = consume(bytes(0x01));
      expect(ctrlA).toEqual([{ key: 'char', char: 'a', ctrl: true }]);
      const ctrlR = consume(bytes(0x12));
      expect(ctrlR).toEqual([{ key: 'char', char: 'r', ctrl: true }]);
    });
  });

  describe('escape sequences', () => {
    it('lone Escape', () => {
      expect(consume(bytes(0x1b))).toEqual([{ key: 'escape' }]);
    });

    it('arrow keys via CSI', () => {
      expect(consume(bytes(0x1b, 0x5b, 0x41))).toEqual([{ key: 'up' }]);
      expect(consume(bytes(0x1b, 0x5b, 0x42))).toEqual([{ key: 'down' }]);
      expect(consume(bytes(0x1b, 0x5b, 0x43))).toEqual([{ key: 'right' }]);
      expect(consume(bytes(0x1b, 0x5b, 0x44))).toEqual([{ key: 'left' }]);
    });

    it('arrows via SS3', () => {
      expect(consume(bytes(0x1b, 0x4f, 0x41))).toEqual([{ key: 'up' }]);
      expect(consume(bytes(0x1b, 0x4f, 0x44))).toEqual([{ key: 'left' }]);
    });

    it('home / end via letter finals', () => {
      expect(consume(bytes(0x1b, 0x5b, 0x48))).toEqual([{ key: 'home' }]);
      expect(consume(bytes(0x1b, 0x5b, 0x46))).toEqual([{ key: 'end' }]);
    });

    it('home / end via tilde forms', () => {
      // ESC [ 1 ~  → Home; ESC [ 4 ~ → End
      expect(consume(ascii('\x1b[1~'))).toEqual([{ key: 'home' }]);
      expect(consume(ascii('\x1b[4~'))).toEqual([{ key: 'end' }]);
    });

    it('delete via ESC [ 3 ~', () => {
      expect(consume(ascii('\x1b[3~'))).toEqual([{ key: 'delete' }]);
    });

    it('pageup / pagedown', () => {
      expect(consume(ascii('\x1b[5~'))).toEqual([{ key: 'pageup' }]);
      expect(consume(ascii('\x1b[6~'))).toEqual([{ key: 'pagedown' }]);
    });

    it('alt + letter via ESC <ch>', () => {
      expect(consume(ascii('\x1bf'))).toEqual([
        { key: 'char', char: 'f', meta: true },
      ]);
      expect(consume(ascii('\x1bb'))).toEqual([
        { key: 'char', char: 'b', meta: true },
      ]);
    });

    it('alt + arrow via CSI 1;3X', () => {
      expect(consume(ascii('\x1b[1;3D'))).toEqual([
        { key: 'left', meta: true },
      ]);
      expect(consume(ascii('\x1b[1;3C'))).toEqual([
        { key: 'right', meta: true },
      ]);
    });

    it('bracketed paste markers', () => {
      expect(consume(ascii('\x1b[200~'))).toEqual([{ key: 'paste-start' }]);
      expect(consume(ascii('\x1b[201~'))).toEqual([{ key: 'paste-end' }]);
    });
  });

  describe('streaming', () => {
    it('buffers partial CSI across pushes', () => {
      const d = new Vt100Decoder();
      expect(d.push(bytes(0x1b, 0x5b))).toEqual([]);
      expect(d.push(bytes(0x41))).toEqual([{ key: 'up' }]);
    });

    it('decodes multi-byte UTF-8 (two-byte)', () => {
      // 'é' is C3 A9 in UTF-8.
      expect(consume(bytes(0xc3, 0xa9))).toEqual([{ key: 'char', char: 'é' }]);
    });

    it('decodes multi-byte UTF-8 (four-byte)', () => {
      // U+1F600 (grinning face) is F0 9F 98 80
      expect(consume(bytes(0xf0, 0x9f, 0x98, 0x80))).toEqual([
        { key: 'char', char: '\u{1F600}' },
      ]);
    });

    it('decodes UTF-8 split across chunks', () => {
      const d = new Vt100Decoder();
      expect(d.push(bytes(0xc3))).toEqual([]);
      expect(d.push(bytes(0xa9))).toEqual([{ key: 'char', char: 'é' }]);
    });

    it('decodes a mixed stream', () => {
      const evs = consume(ascii('hi\x1b[Dx'));
      expect(evs.map((e) => `${e.key}:${e.char ?? ''}`)).toEqual([
        'char:h',
        'char:i',
        'left:',
        'char:x',
      ]);
    });
  });
});
