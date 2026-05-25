import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createVarStore } from './variables.js';
import { defaultSettings } from './settings.js';
import {
  PROMPT_BACKTICK_EXECUTOR,
  renderPrompt,
  renderPromptByName,
  type PromptContext,
} from './prompt.js';
import type { CondStack, CondStackFrame, IfState } from '../types/repl.js';
import type { PromptStatus } from '../types/scanner.js';

// Capture the original executor so per-test mocks can be undone in `afterEach`.
const ORIG_PROMPT_EXECUTOR = PROMPT_BACKTICK_EXECUTOR.current;

/** Minimal in-memory CondStack stub for tests. */
const makeCond = (initial?: IfState): CondStack => {
  const stack: CondStackFrame[] = [];
  if (initial !== undefined) stack.push({ state: initial, branchTaken: false });
  return {
    push: (state) => stack.push({ state, branchTaken: false }),
    pop: () => stack.pop(),
    top: () => (stack.length === 0 ? undefined : stack[stack.length - 1]),
    isActive: () => {
      const top = stack[stack.length - 1];
      if (!top) return true;
      return !(['false', 'else-false', 'ignored'] as IfState[]).includes(
        top.state,
      );
    },
    setState: (state) => {
      const top = stack[stack.length - 1];
      if (top) top.state = state;
    },
    depth: () => stack.length,
  };
};

/** Build a fully-populated PromptContext for tests. */
const makeCtx = (overrides: Partial<PromptContext> = {}): PromptContext => {
  const vars = createVarStore();
  const settings = defaultSettings(vars);
  return {
    settings,
    cond: makeCond(),
    promptStatus: 'ready' as PromptStatus,
    lineNumber: 1,
    inTransaction: 'idle',
    pipelineState: 'off',
    ...overrides,
  };
};

/** Stub Connection — only exposes the few hooks the prompt actually uses. */
type StubConnInit = {
  database?: string;
  user?: string;
  host?: string;
  port?: number;
  pid?: number;
  parameterStatus?: Record<string, string>;
};
const stubConnection = (init: StubConnInit = {}): unknown => ({
  database: init.database ?? 'mydb',
  user: init.user ?? 'alice',
  host: init.host ?? 'db.example.com',
  port: init.port ?? 5432,
  pid: init.pid ?? 12345,
  parameterStatus: (name: string) => init.parameterStatus?.[name],
});

describe('renderPrompt — literal and %% handling', () => {
  test('plain string passes through unchanged', () => {
    const ctx = makeCtx();
    expect(renderPrompt('hello> ', ctx)).toBe('hello> ');
  });

  test('%% becomes a literal percent sign', () => {
    const ctx = makeCtx();
    expect(renderPrompt('100%% complete', ctx)).toBe('100% complete');
  });

  test('unknown escape passes through as the bare character', () => {
    const ctx = makeCtx();
    expect(renderPrompt('%Z%Y', ctx)).toBe('ZY');
  });

  test('trailing % is dropped', () => {
    const ctx = makeCtx();
    expect(renderPrompt('foo%', ctx)).toBe('foo');
  });
});

describe('renderPrompt — connection-derived escapes', () => {
  test('%n / %/ / %M / %m / %> against a stub connection', () => {
    const ctx = makeCtx();
    ctx.settings.db = stubConnection({
      database: 'shop',
      user: 'alice',
      host: 'db.example.com',
      port: 5433,
    }) as PromptContext['settings']['db'];
    expect(renderPrompt('%n', ctx)).toBe('alice');
    expect(renderPrompt('%/', ctx)).toBe('shop');
    expect(renderPrompt('%M', ctx)).toBe('db.example.com');
    expect(renderPrompt('%m', ctx)).toBe('db');
    expect(renderPrompt('%>', ctx)).toBe('5433');
  });

  test('%~ → "~" when current_db === user, else current_db', () => {
    const ctxSame = makeCtx();
    ctxSame.settings.db = stubConnection({
      database: 'alice',
      user: 'alice',
    }) as PromptContext['settings']['db'];
    expect(renderPrompt('%~', ctxSame)).toBe('~');

    const ctxDiff = makeCtx();
    ctxDiff.settings.db = stubConnection({
      database: 'shop',
      user: 'alice',
    }) as PromptContext['settings']['db'];
    expect(renderPrompt('%~', ctxDiff)).toBe('shop');
  });

  test('%p emits backend pid as decimal', () => {
    const ctx = makeCtx();
    ctx.settings.db = stubConnection({
      pid: 9876,
    }) as PromptContext['settings']['db'];
    expect(renderPrompt('%p', ctx)).toBe('9876');
  });

  test('connection-bound escapes emit empty string when db is null', () => {
    const ctx = makeCtx();
    expect(renderPrompt('%n%/%M%>%p', ctx)).toBe('');
  });

  test('%M with empty host emits [local]', () => {
    const ctx = makeCtx();
    ctx.settings.db = stubConnection({
      host: '',
    }) as PromptContext['settings']['db'];
    expect(renderPrompt('%M', ctx)).toBe('[local]');
  });

  test('%M with /var/run socket path emits [local:/var/run]', () => {
    const ctx = makeCtx();
    ctx.settings.db = stubConnection({
      host: '/var/run',
    }) as PromptContext['settings']['db'];
    expect(renderPrompt('%M', ctx)).toBe('[local:/var/run]');
  });
});

describe('renderPrompt — superuser and transaction', () => {
  test('%# is "#" when IS_SUPERUSER=on, "#" otherwise', () => {
    const ctx = makeCtx();
    expect(renderPrompt('%#', ctx)).toBe('>');
    ctx.settings.vars.set('IS_SUPERUSER', 'on');
    expect(renderPrompt('%#', ctx)).toBe('#');
  });

  test('%x against transaction states', () => {
    const idle = makeCtx({ inTransaction: 'idle' });
    idle.settings.db = stubConnection() as PromptContext['settings']['db'];
    expect(renderPrompt('%x', idle)).toBe('');

    const inBlock = makeCtx({ inTransaction: 'in-block' });
    inBlock.settings.db = stubConnection() as PromptContext['settings']['db'];
    expect(renderPrompt('%x', inBlock)).toBe('*');

    const failed = makeCtx({ inTransaction: 'failed' });
    failed.settings.db = stubConnection() as PromptContext['settings']['db'];
    expect(renderPrompt('%x', failed)).toBe('!');

    const noConn = makeCtx({ inTransaction: 'idle' });
    expect(renderPrompt('%x', noConn)).toBe('?');
  });

  test('%P reflects pipeline state', () => {
    const off = makeCtx({ pipelineState: 'off' });
    off.settings.db = stubConnection() as PromptContext['settings']['db'];
    expect(renderPrompt('%P', off)).toBe('off');

    const on = makeCtx({ pipelineState: 'on' });
    on.settings.db = stubConnection() as PromptContext['settings']['db'];
    expect(renderPrompt('%P', on)).toBe('on');

    const aborted = makeCtx({ pipelineState: 'aborted' });
    aborted.settings.db = stubConnection() as PromptContext['settings']['db'];
    expect(renderPrompt('%P', aborted)).toBe('abort');
  });
});

describe('renderPrompt — %R session state', () => {
  test('PROMPT1 ready + connected + multi-line → "="', () => {
    const ctx = makeCtx({ promptStatus: 'ready' });
    ctx.settings.db = stubConnection() as PromptContext['settings']['db'];
    expect(renderPrompt('%R', ctx)).toBe('=');
  });

  test('PROMPT1 ready + no connection → "!"', () => {
    const ctx = makeCtx({ promptStatus: 'ready' });
    expect(renderPrompt('%R', ctx)).toBe('!');
  });

  test('PROMPT1 ready + singleline → "^"', () => {
    const ctx = makeCtx({ promptStatus: 'ready' });
    ctx.settings.db = stubConnection() as PromptContext['settings']['db'];
    ctx.settings.singleline = true;
    expect(renderPrompt('%R', ctx)).toBe('^');
  });

  test('inactive cond stack frame → "@"', () => {
    const ctx = makeCtx({
      promptStatus: 'ready',
      cond: makeCond('false'),
    });
    ctx.settings.db = stubConnection() as PromptContext['settings']['db'];
    expect(renderPrompt('%R', ctx)).toBe('@');
  });

  test('PROMPT2 continue → "-"', () => {
    const ctx = makeCtx({ promptStatus: 'continue' });
    expect(renderPrompt('%R', ctx)).toBe('-');
  });

  test('PROMPT2 comment → "*"', () => {
    const ctx = makeCtx({ promptStatus: 'comment' });
    expect(renderPrompt('%R', ctx)).toBe('*');
  });

  test('PROMPT2 paren → "("', () => {
    const ctx = makeCtx({ promptStatus: 'paren' });
    expect(renderPrompt('%R', ctx)).toBe('(');
  });

  test('COPY status → empty', () => {
    const ctx = makeCtx({ promptStatus: 'copy' });
    expect(renderPrompt('%R', ctx)).toBe('');
  });
});

describe('renderPrompt — special markers and substitutions', () => {
  test('%[ and %] strip to nothing', () => {
    const ctx = makeCtx();
    expect(renderPrompt('%[\x1b[1m%]bold%[\x1b[0m%]', ctx)).toBe(
      '\x1b[1mbold\x1b[0m',
    );
  });

  test('%:varname: substitutes from settings.vars', () => {
    const ctx = makeCtx();
    ctx.settings.vars.set('FOO', 'bar');
    expect(renderPrompt('hello %:FOO:!', ctx)).toBe('hello bar!');
  });

  test('%:unknown: substitutes empty string', () => {
    const ctx = makeCtx();
    expect(renderPrompt('[%:NOPE:]', ctx)).toBe('[]');
  });

  test('%nnn octal byte (e.g. %033 → ESC)', () => {
    const ctx = makeCtx();
    expect(renderPrompt('%033[1m', ctx)).toBe('\x1b[1m');
  });

  test('%nn (two-digit octal) — %07 → BEL', () => {
    const ctx = makeCtx();
    expect(renderPrompt('%07', ctx)).toBe('\x07');
  });

  test('%a emits BEL', () => {
    const ctx = makeCtx();
    expect(renderPrompt('%a', ctx)).toBe('\x07');
  });

  test('%l emits current line number', () => {
    const ctx = makeCtx({ lineNumber: 42 });
    expect(renderPrompt('line %l', ctx)).toBe('line 42');
  });

  test('%`cmd` substitutes the command stdout (newline trimmed)', () => {
    const ctx = makeCtx();
    PROMPT_BACKTICK_EXECUTOR.current = (cmd: string) => {
      expect(cmd).toBe('echo foo');
      return 'foo\n';
    };
    try {
      expect(renderPrompt('out:%`echo foo`!', ctx)).toBe('out:foo!');
    } finally {
      PROMPT_BACKTICK_EXECUTOR.current = ORIG_PROMPT_EXECUTOR;
    }
  });

  test('%`cmd` re-runs on every render (no cache)', () => {
    const ctx = makeCtx();
    const exec = vi.fn().mockReturnValueOnce('1\n').mockReturnValueOnce('2\n');
    PROMPT_BACKTICK_EXECUTOR.current = exec;
    try {
      expect(renderPrompt('%`pwd`', ctx)).toBe('1');
      expect(renderPrompt('%`pwd`', ctx)).toBe('2');
      expect(exec).toHaveBeenCalledTimes(2);
    } finally {
      PROMPT_BACKTICK_EXECUTOR.current = ORIG_PROMPT_EXECUTOR;
    }
  });

  test('%`cmd` failure → empty substitution and stderr diagnostic', () => {
    const ctx = makeCtx();
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    PROMPT_BACKTICK_EXECUTOR.current = () => {
      throw new Error('exit 1');
    };
    try {
      expect(renderPrompt('a%`bogus`b', ctx)).toBe('ab');
      expect(stderrChunks.join('')).toMatch(/psql: error: \\!: bogus: exit 1/);
    } finally {
      PROMPT_BACKTICK_EXECUTOR.current = ORIG_PROMPT_EXECUTOR;
      process.stderr.write = origWrite;
    }
  });

  test('unterminated %`...` consumes the rest without spawning', () => {
    const ctx = makeCtx();
    const exec = vi.fn();
    PROMPT_BACKTICK_EXECUTOR.current = exec;
    try {
      expect(renderPrompt('start%`no closer here', ctx)).toBe('start');
      expect(exec).not.toHaveBeenCalled();
    } finally {
      PROMPT_BACKTICK_EXECUTOR.current = ORIG_PROMPT_EXECUTOR;
    }
  });
});

// Belt-and-braces: ensure other tests in this file are insulated from any
// stray mock left behind by the backtick tests.
beforeEach(() => {
  PROMPT_BACKTICK_EXECUTOR.current = ORIG_PROMPT_EXECUTOR;
});
afterEach(() => {
  PROMPT_BACKTICK_EXECUTOR.current = ORIG_PROMPT_EXECUTOR;
});

describe('renderPrompt — search_path and hot-standby', () => {
  test('%S returns search_path GUC, or ? when missing', () => {
    const ctx = makeCtx();
    ctx.settings.db = stubConnection({
      parameterStatus: { search_path: 'public,extensions' },
    }) as PromptContext['settings']['db'];
    expect(renderPrompt('%S', ctx)).toBe('public,extensions');

    const ctx2 = makeCtx();
    ctx2.settings.db = stubConnection() as PromptContext['settings']['db'];
    expect(renderPrompt('%S', ctx2)).toBe('?');
  });

  test('%i reflects in_hot_standby GUC', () => {
    const ctx = makeCtx();
    ctx.settings.db = stubConnection({
      parameterStatus: { in_hot_standby: 'on' },
    }) as PromptContext['settings']['db'];
    expect(renderPrompt('%i', ctx)).toBe('standby');

    const ctx2 = makeCtx();
    ctx2.settings.db = stubConnection({
      parameterStatus: { in_hot_standby: 'off' },
    }) as PromptContext['settings']['db'];
    expect(renderPrompt('%i', ctx2)).toBe('primary');

    const ctx3 = makeCtx();
    ctx3.settings.db = stubConnection() as PromptContext['settings']['db'];
    expect(renderPrompt('%i', ctx3)).toBe('?');
  });
});

describe('renderPromptByName', () => {
  test('PROMPT1 uses settings.prompt1', () => {
    const ctx = makeCtx({ promptStatus: 'ready' });
    ctx.settings.db = stubConnection({
      database: 'shop',
    }) as PromptContext['settings']['db'];
    ctx.settings.prompt1 = '%/=> ';
    expect(renderPromptByName('PROMPT1', ctx)).toBe('shop=> ');
  });

  test('PROMPT2 uses settings.prompt2 and reflects %w from PROMPT1', () => {
    const ctx = makeCtx({ promptStatus: 'ready' });
    ctx.settings.db = stubConnection({
      database: 'shop',
    }) as PromptContext['settings']['db'];
    ctx.settings.prompt1 = '%/=> ';
    renderPromptByName('PROMPT1', ctx);
    // After rendering "shop=> " (7 chars), PROMPT2 %w should be 7 spaces.
    ctx.settings.prompt2 = '%w';
    expect(renderPromptByName('PROMPT2', ctx)).toBe('       ');
  });

  test('PROMPT3 uses settings.prompt3', () => {
    const ctx = makeCtx({ promptStatus: 'copy' });
    ctx.settings.prompt3 = 'copy>> ';
    expect(renderPromptByName('PROMPT3', ctx)).toBe('copy>> ');
  });
});
