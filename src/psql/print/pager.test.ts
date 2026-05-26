import { PassThrough } from 'stream';

import { describe, test, expect } from 'vitest';

import type { OpenPagerOpts } from './pager.js';
import { isPagerNeeded, openPager, shouldPage } from './pager.js';

const isWindows = process.platform === 'win32';

const makeStdout = (
  overrides: { isTTY?: boolean; rows?: number } = {},
): { stream: NodeJS.WritableStream; chunks: string[] } => {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => {
    chunks.push(chunk.toString('utf-8'));
  });
  Object.assign(stream, {
    isTTY: overrides.isTTY ?? false,
    rows: overrides.rows ?? 0,
  });
  return { stream: stream as unknown as NodeJS.WritableStream, chunks };
};

const baseOpts = (overrides: Partial<OpenPagerOpts> = {}): OpenPagerOpts => ({
  pager: 'off',
  pagerMinLines: 0,
  env: {},
  isTty: true,
  terminalHeight: 24,
  ...overrides,
});

describe('isPagerNeeded', () => {
  test("returns false when pager is 'off'", () => {
    expect(isPagerNeeded(baseOpts({ pager: 'off', lines: 1000 }))).toBe(false);
  });

  test("returns true when pager is 'always' with a non-empty command", () => {
    expect(isPagerNeeded(baseOpts({ pager: 'always', pagerCmd: 'cat' }))).toBe(
      true,
    );
  });

  test("returns false when pager is 'always' but command is whitespace-only", () => {
    expect(
      isPagerNeeded(baseOpts({ pager: 'always', env: { PAGER: '   \t  ' } })),
    ).toBe(false);
  });

  test("returns false when pager is 'on' but not a TTY", () => {
    expect(
      isPagerNeeded(
        baseOpts({ pager: 'on', isTty: false, lines: 1000, pagerCmd: 'cat' }),
      ),
    ).toBe(false);
  });

  test("returns false when pager is 'on' and lines unknown", () => {
    expect(isPagerNeeded(baseOpts({ pager: 'on', pagerCmd: 'cat' }))).toBe(
      false,
    );
  });

  test("returns false when pager is 'on' and lines below threshold", () => {
    expect(
      isPagerNeeded(
        baseOpts({
          pager: 'on',
          pagerCmd: 'cat',
          terminalHeight: 24,
          pagerMinLines: 0,
          lines: 10,
        }),
      ),
    ).toBe(false);
  });

  test("returns true when pager is 'on' and lines meet terminal threshold", () => {
    expect(
      isPagerNeeded(
        baseOpts({
          pager: 'on',
          pagerCmd: 'cat',
          terminalHeight: 24,
          pagerMinLines: 0,
          lines: 24,
        }),
      ),
    ).toBe(true);
  });

  test('pagerMinLines raises the threshold above terminal height', () => {
    expect(
      isPagerNeeded(
        baseOpts({
          pager: 'on',
          pagerCmd: 'cat',
          terminalHeight: 24,
          pagerMinLines: 100,
          lines: 50,
        }),
      ),
    ).toBe(false);
    expect(
      isPagerNeeded(
        baseOpts({
          pager: 'on',
          pagerCmd: 'cat',
          terminalHeight: 24,
          pagerMinLines: 100,
          lines: 100,
        }),
      ),
    ).toBe(true);
  });

  test("on Windows with no pager set, returns false even when 'always'", () => {
    if (!isWindows) return;
    expect(isPagerNeeded(baseOpts({ pager: 'always', env: {} }))).toBe(false);
  });
});

describe('openPager — no spawn cases', () => {
  test("pager: 'off' returns provided stdout, close() returns 0", async () => {
    const { stream } = makeStdout({ isTTY: true });
    const handle = openPager(baseOpts({ pager: 'off', stdout: stream }));
    expect(handle.spawned).toBe(false);
    expect(handle.out).toBe(stream);
    expect(await handle.close()).toBe(0);
  });

  test("pager: 'on' with lines below threshold does not spawn", async () => {
    const { stream } = makeStdout({ isTTY: true });
    const handle = openPager(
      baseOpts({
        pager: 'on',
        pagerCmd: 'cat',
        stdout: stream,
        terminalHeight: 24,
        lines: 5,
      }),
    );
    expect(handle.spawned).toBe(false);
    expect(handle.out).toBe(stream);
    await handle.close();
  });

  test("pager: 'on' on a non-TTY never spawns, even with many lines", async () => {
    const { stream } = makeStdout({ isTTY: false });
    const handle = openPager(
      baseOpts({
        pager: 'on',
        pagerCmd: 'cat',
        stdout: stream,
        isTty: false,
        terminalHeight: 24,
        lines: 10_000,
      }),
    );
    expect(handle.spawned).toBe(false);
    expect(handle.out).toBe(stream);
    await handle.close();
  });

  test('empty PAGER falls back to default (skipped on Windows)', async () => {
    if (isWindows) {
      // On Windows DEFAULT_PAGER is empty, so even pager: 'always' won't spawn.
      const { stream } = makeStdout({ isTTY: true });
      const handle = openPager(
        baseOpts({
          pager: 'always',
          env: {},
          stdout: stream,
        }),
      );
      expect(handle.spawned).toBe(false);
      await handle.close();
      return;
    }
    // On POSIX with no PAGER and no override, the default is `less`. We
    // don't actually run `less` here — just confirm isPagerNeeded reports
    // true so the default-resolution logic is wired up.
    expect(
      isPagerNeeded(
        baseOpts({
          pager: 'always',
          env: {},
        }),
      ),
    ).toBe(true);
  });
});

describe('openPager — spawn cases', () => {
  test.skipIf(isWindows)(
    "pager: 'always' with PAGER=cat spawns, accepts writes, close returns 0",
    async () => {
      const { stream } = makeStdout({ isTTY: true });
      const handle = openPager(
        baseOpts({
          pager: 'always',
          env: { PAGER: 'cat' },
          stdout: stream,
        }),
      );
      expect(handle.spawned).toBe(true);
      expect(handle.out).not.toBe(stream);
      handle.out.write('hello\n');
      handle.out.write('world\n');
      const code = await handle.close();
      expect(code).toBe(0);
    },
  );

  test.skipIf(isWindows)(
    "pager: 'on' with lines >= threshold AND TTY-ish spawns",
    async () => {
      const { stream } = makeStdout({ isTTY: true });
      const handle = openPager(
        baseOpts({
          pager: 'on',
          env: { PAGER: 'cat' },
          stdout: stream,
          isTty: true,
          terminalHeight: 24,
          lines: 100,
        }),
      );
      expect(handle.spawned).toBe(true);
      handle.out.write('row\n');
      const code = await handle.close();
      expect(code).toBe(0);
    },
  );

  test.skipIf(isWindows)('PSQL_PAGER overrides PAGER', async () => {
    const { stream } = makeStdout({ isTTY: true });
    // PSQL_PAGER is a working command; PAGER is something that would fail
    // if used. If PSQL_PAGER didn't take precedence, we'd get a non-zero
    // exit (the shell would try to run /nonexistent/binary).
    const handle = openPager(
      baseOpts({
        pager: 'always',
        env: { PSQL_PAGER: 'cat', PAGER: '/definitely/not/a/binary' },
        stdout: stream,
      }),
    );
    expect(handle.spawned).toBe(true);
    handle.out.write('hi\n');
    const code = await handle.close();
    expect(code).toBe(0);
  });

  test.skipIf(isWindows)(
    'pagerCmd overrides both PSQL_PAGER and PAGER',
    async () => {
      const { stream } = makeStdout({ isTTY: true });
      const handle = openPager(
        baseOpts({
          pager: 'always',
          pagerCmd: 'cat',
          env: {
            PSQL_PAGER: '/definitely/not/a/binary',
            PAGER: '/also/nope',
          },
          stdout: stream,
        }),
      );
      expect(handle.spawned).toBe(true);
      handle.out.write('hi\n');
      const code = await handle.close();
      expect(code).toBe(0);
    },
  );

  test.skipIf(isWindows)(
    'pager that exits early — writes after exit do not crash (EPIPE swallowed)',
    async () => {
      const { stream } = makeStdout({ isTTY: true });
      const handle = openPager(
        baseOpts({
          pager: 'always',
          // Read one line, then exit. Subsequent writes will get EPIPE.
          pagerCmd: "sh -c 'head -n 1 > /dev/null; exit 0'",
          stdout: stream,
        }),
      );
      expect(handle.spawned).toBe(true);
      handle.out.write('line 1\n');
      // Give the pager time to actually exit.
      await new Promise((r) => setTimeout(r, 50));
      // These writes may EPIPE — they MUST NOT crash the process.
      for (let i = 0; i < 100; i++) {
        try {
          handle.out.write(`line ${i}\n`);
        } catch {
          // Synchronous EPIPE is fine too.
        }
      }
      const code = await handle.close();
      // sh -c '... exit 0' should report 0.
      expect(code).toBe(0);
    },
  );

  test.skipIf(isWindows)(
    'shell-y pagerCmd (contains spaces / redirects) is spawned via shell',
    async () => {
      const { stream } = makeStdout({ isTTY: true });
      const handle = openPager(
        baseOpts({
          pager: 'always',
          pagerCmd: 'cat | cat',
          stdout: stream,
        }),
      );
      expect(handle.spawned).toBe(true);
      handle.out.write('piped\n');
      const code = await handle.close();
      expect(code).toBe(0);
    },
  );
});

describe('shouldPage', () => {
  const ttyStream = (): NodeJS.WritableStream => {
    const s = new PassThrough();
    Object.assign(s, { isTTY: true, rows: 24 });
    return s as unknown as NodeJS.WritableStream;
  };
  const pipeStream = (): NodeJS.WritableStream => {
    const s = new PassThrough();
    Object.assign(s, { isTTY: false });
    return s as unknown as NodeJS.WritableStream;
  };

  test("pager 'off' never pages, even with thousands of rows", () => {
    expect(
      shouldPage({
        pager: 'off',
        pagerMinLines: 0,
        rowCount: 10_000,
        colCount: 5,
        output: ttyStream(),
        redirectedOutput: false,
        pagerCmd: 'cat',
      }),
    ).toBe(false);
  });

  test("pager 'always' pages on a TTY", () => {
    expect(
      shouldPage({
        pager: 'always',
        pagerMinLines: 0,
        rowCount: 0,
        colCount: 1,
        output: ttyStream(),
        redirectedOutput: false,
        pagerCmd: 'cat',
      }),
    ).toBe(true);
  });

  test("pager 'always' but redirected output (`\\o FILE`) never pages", () => {
    expect(
      shouldPage({
        pager: 'always',
        pagerMinLines: 0,
        rowCount: 10_000,
        colCount: 5,
        output: ttyStream(),
        redirectedOutput: true,
        pagerCmd: 'cat',
      }),
    ).toBe(false);
  });

  test("pager 'always' on a non-TTY output never pages", () => {
    expect(
      shouldPage({
        pager: 'always',
        pagerMinLines: 0,
        rowCount: 10_000,
        colCount: 5,
        output: pipeStream(),
        redirectedOutput: false,
        pagerCmd: 'cat',
      }),
    ).toBe(false);
  });

  test("pager 'on' (default) under the threshold does not page", () => {
    expect(
      shouldPage({
        pager: 'on',
        pagerMinLines: 0,
        rowCount: 5,
        colCount: 1,
        output: ttyStream(),
        redirectedOutput: false,
        terminalHeight: 24,
        isTty: true,
        pagerCmd: 'cat',
      }),
    ).toBe(false);
  });

  test("pager 'on' (default) at the threshold pages", () => {
    expect(
      shouldPage({
        pager: 'on',
        pagerMinLines: 0,
        rowCount: 24,
        colCount: 1,
        output: ttyStream(),
        redirectedOutput: false,
        terminalHeight: 24,
        isTty: true,
        pagerCmd: 'cat',
      }),
    ).toBe(true);
  });

  test('pagerMinLines raises the threshold above terminal height', () => {
    // 50 rows + 4 overhead < pagerMinLines=100 → no page.
    expect(
      shouldPage({
        pager: 'on',
        pagerMinLines: 100,
        rowCount: 50,
        colCount: 1,
        output: ttyStream(),
        redirectedOutput: false,
        terminalHeight: 24,
        isTty: true,
        pagerCmd: 'cat',
      }),
    ).toBe(false);
    // 100 rows + 4 overhead >= 100 → page.
    expect(
      shouldPage({
        pager: 'on',
        pagerMinLines: 100,
        rowCount: 100,
        colCount: 1,
        output: ttyStream(),
        redirectedOutput: false,
        terminalHeight: 24,
        isTty: true,
        pagerCmd: 'cat',
      }),
    ).toBe(true);
  });

  test('whitespace-only PAGER disables the pager entirely', () => {
    expect(
      shouldPage({
        pager: 'always',
        pagerMinLines: 0,
        rowCount: 10,
        colCount: 1,
        output: ttyStream(),
        redirectedOutput: false,
        env: { PAGER: '   ' },
      }),
    ).toBe(false);
  });
});
