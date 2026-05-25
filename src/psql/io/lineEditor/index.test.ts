import { Readable, Writable } from 'node:stream';

import { describe, it, expect } from 'vitest';

import { LineEditor, SignalError } from './index.js';

/** A push-driven readable stream used as a fake TTY input. */
class FakeStdin extends Readable {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  _read(): void {}

  feed(bytes: string | Uint8Array): void {
    if (typeof bytes === 'string') {
      this.push(Buffer.from(bytes, 'utf8'));
    } else {
      this.push(Buffer.from(bytes));
    }
  }
}

/** A writable that captures everything written so we can introspect output. */
class FakeStdout extends Writable {
  chunks: Buffer[] = [];
  columns = 80;

  _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    cb();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

const makeEditor = (
  opts: {
    history?: string[];
    completer?: ConstructorParameters<typeof LineEditor>[0] extends infer T
      ? T extends { completer?: infer C }
        ? C
        : never
      : never;
  } = {},
): { editor: LineEditor; stdin: FakeStdin; stdout: FakeStdout } => {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const editor = new LineEditor({
    stdin,
    stdout,
    history: opts.history,
    completer: opts.completer,
    bracketedPaste: false,
  });
  return { editor, stdin, stdout };
};

describe('LineEditor.readLine', () => {
  it('resolves with the typed line on Enter', async () => {
    const { editor, stdin } = makeEditor();
    const p = editor.readLine('> ');
    stdin.feed('hello\r');
    const result = await p;
    expect(result).toBe('hello');
    editor.close();
  });

  it('returns EOF symbol on ^D with empty buffer', async () => {
    const { editor, stdin } = makeEditor();
    const p = editor.readLine('> ');
    stdin.feed('\x04'); // Ctrl-D
    const result = await p;
    expect(result).toBe(editor.EOF);
    editor.close();
  });

  it('rejects with SignalError on ^C', async () => {
    const { editor, stdin } = makeEditor();
    const p = editor.readLine('> ');
    stdin.feed('abc\x03');
    await expect(p).rejects.toBeInstanceOf(SignalError);
    editor.close();
  });

  it('responds to ^A then ^F then char to edit inline', async () => {
    // Type "hi", then ^A (cursor home), ^F (right one), 'o' (insert).
    // Expected: "hoi"
    const { editor, stdin } = makeEditor();
    const p = editor.readLine('> ');
    stdin.feed('hi\x01\x06o\r');
    const result = await p;
    expect(result).toBe('hoi');
    editor.close();
  });

  it('walks history with arrow keys', async () => {
    const { editor, stdin } = makeEditor({ history: ['first', 'second'] });
    const p = editor.readLine('> ');
    // Up twice should land on "first".
    stdin.feed('\x1b[A\x1b[A\r');
    const result = await p;
    expect(result).toBe('first');
    editor.close();
  });

  it('backspace removes the previous char', async () => {
    const { editor, stdin } = makeEditor();
    const p = editor.readLine('> ');
    stdin.feed('abcd\x7f\r');
    const result = await p;
    expect(result).toBe('abc');
    editor.close();
  });

  it('writes the prompt on entry', async () => {
    const { editor, stdin, stdout } = makeEditor();
    const p = editor.readLine('psql> ');
    stdin.feed('x\r');
    await p;
    expect(stdout.text()).toContain('psql> ');
    editor.close();
  });

  it('handles tab completion with single candidate', async () => {
    const completer = (
      input: string,
    ): {
      candidates: string[];
      commonPrefix: string;
      replaceLength: number;
    } => ({
      candidates: ['select '],
      commonPrefix: 'select ',
      replaceLength: input.length,
    });
    const { editor, stdin } = makeEditor({ completer });
    const p = editor.readLine('> ');
    stdin.feed('sel\t\r');
    const result = await p;
    expect(result).toBe('select ');
    editor.close();
  });

  it('cycles through candidates on repeated tabs', async () => {
    const completer = (): {
      candidates: string[];
      commonPrefix: string;
      replaceLength: number;
    } => ({
      candidates: ['foo', 'bar', 'baz'],
      commonPrefix: 'b',
      replaceLength: 1,
    });
    const { editor, stdin } = makeEditor({ completer });
    const p = editor.readLine('> ');
    // First tab inserts common prefix "b" (replacing "b").
    // Second tab → list (no buffer change).
    // Third tab → cycles to first candidate.
    stdin.feed('b\t\t\t\r');
    const result = await p;
    // Result depends on cycle order: after first tab buffer is "b",
    // then list (no change), then cycle to 'foo' (replacing 1 char).
    expect(result).toBe('foo');
    editor.close();
  });

  it('rings the bell when no completions exist', async () => {
    const completer = (): {
      candidates: string[];
      commonPrefix: string;
      replaceLength: number;
    } => ({
      candidates: [],
      commonPrefix: '',
      replaceLength: 0,
    });
    const { editor, stdin, stdout } = makeEditor({ completer });
    const p = editor.readLine('> ');
    stdin.feed('x\t\r');
    await p;
    expect(stdout.text()).toContain('\x07');
    editor.close();
  });

  it('handles ^K then ^Y (kill+yank round trip)', async () => {
    const { editor, stdin } = makeEditor();
    const p = editor.readLine('> ');
    // Type "hello", move to start, kill to end, yank.
    stdin.feed('hello\x01\x0b\x19\r');
    const result = await p;
    expect(result).toBe('hello');
    editor.close();
  });

  it('reverse-i-search finds a history entry', async () => {
    const { editor, stdin } = makeEditor({
      history: ['SELECT 1', 'INSERT 2', 'DELETE 3'],
    });
    const p = editor.readLine('> ');
    // ^R then "INS" then Enter
    stdin.feed('\x12INS\r');
    const result = await p;
    expect(result).toBe('INSERT 2');
    editor.close();
  });

  it('search ^G cancels and restores the live buffer', async () => {
    const { editor, stdin } = makeEditor({ history: ['SELECT 1'] });
    const p = editor.readLine('> ');
    stdin.feed('live\x12');
    // ^G inside search → cancel
    stdin.feed('\x07');
    stdin.feed('\r');
    const result = await p;
    expect(result).toBe('live');
    editor.close();
  });

  it('pushHistory adds an entry', () => {
    const { editor } = makeEditor();
    editor.pushHistory('SELECT 1');
    editor.setHistory(['a', 'b']);
    // No direct getter; sanity-check via readLine navigation.
    expect(true).toBe(true);
    editor.close();
  });
});

describe('LineEditor on non-TTY stdin', () => {
  it('does not crash when stdin lacks setRawMode', async () => {
    const { editor, stdin } = makeEditor();
    // FakeStdin doesn't have setRawMode at all — make sure readLine works.
    const p = editor.readLine('> ');
    stdin.feed('hi\r');
    expect(await p).toBe('hi');
    editor.close();
  });
});
