import { Readable, Writable } from 'node:stream';

import { describe, it, expect } from 'vitest';

import { readLine } from './input.js';

/** A push-driven readable used as a non-TTY input source. */
class FakeStdin extends Readable {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  _read(): void {}

  feed(text: string): void {
    this.push(Buffer.from(text, 'utf8'));
  }

  eof(): void {
    this.push(null);
  }
}

/** A writable that captures the prompt / echo output. */
class FakeStdout extends Writable {
  chunks: Buffer[] = [];

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

describe('readLine (non-TTY input)', () => {
  it('reads a line normally when echo is on', async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const p = readLine('pw> ', { echo: true, input: stdin, output: stdout });
    stdin.feed('hunter2\n');
    expect(await p).toBe('hunter2');
    // The prompt is written to the output stream.
    expect(stdout.text()).toContain('pw> ');
  });

  it('still reads the line when echo is off (no-op on non-TTY)', async () => {
    // Upstream `simple_prompt` consumes the line even when stdin is not a
    // terminal; echo suppression is simply moot. We must not block or drop it.
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const p = readLine('secret> ', {
      echo: false,
      input: stdin,
      output: stdout,
    });
    stdin.feed('s3cr3t\n');
    expect(await p).toBe('s3cr3t');
  });

  it('resolves to empty string on EOF before any newline', async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const p = readLine('', { echo: true, input: stdin, output: stdout });
    stdin.eof();
    expect(await p).toBe('');
  });

  it('does not write a prompt when the prompt is empty', async () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const p = readLine('', { echo: false, input: stdin, output: stdout });
    stdin.feed('value\n');
    expect(await p).toBe('value');
    expect(stdout.text()).toBe('');
  });
});
