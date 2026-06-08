import { describe, expect, it, vi, type Mock } from 'vitest';

import type { PagerHandle } from '../print/pager.js';

import {
  helpSQL,
  helpVariables,
  setHelpPagerOpener,
  slashUsage,
  slashUsageHelp,
  usage,
} from './help.js';

/** Minimal WritableStream stand-in that records every `.write()` call. */
class MemoryStream {
  chunks: string[] = [];
  /** Toggled by the pager-routing tests to fake an interactive terminal. */
  isTTY = false;
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }
  text(): string {
    return this.chunks.join('');
  }
}

const collect = (fn: (s: MemoryStream) => void): string => {
  const s = new MemoryStream();
  fn(s);
  return s.text();
};

describe('usage', () => {
  it('renders the default CLI --help text', () => {
    expect(
      collect((s) => {
        usage(s as unknown as NodeJS.WritableStream);
      }),
    ).toMatchSnapshot();
  });

  it('substitutes a custom progname', () => {
    const out = collect((s) => {
      usage(s as unknown as NodeJS.WritableStream, {
        progname: 'neonctl-psql',
      });
    });
    expect(out).toContain(
      'neonctl-psql is the PostgreSQL interactive terminal.',
    );
    expect(out).toContain('  neonctl-psql [OPTION]... [DBNAME [USERNAME]]');
  });

  it('substitutes a custom default field separator', () => {
    const out = collect((s) => {
      usage(s as unknown as NodeJS.WritableStream, { defaultFieldSep: ';' });
    });
    expect(out).toContain(
      'field separator for unaligned output (default: ";")',
    );
  });
});

describe('slashUsage', () => {
  it('renders the default backslash-command help', () => {
    expect(
      collect((s) => {
        slashUsage(s as unknown as NodeJS.WritableStream, false);
      }),
    ).toMatchSnapshot();
  });

  it('annotates current connection when currentDb is set', () => {
    const out = collect((s) => {
      slashUsage(s as unknown as NodeJS.WritableStream, false, {
        currentDb: 'mydb',
      });
    });
    expect(out).toContain('connect to new database (currently "mydb")');
  });

  it('annotates "no connection" when currentDb is unset', () => {
    const out = collect((s) => {
      slashUsage(s as unknown as NodeJS.WritableStream, false);
    });
    expect(out).toContain('connect to new database (currently no connection)');
  });

  it('reflects runtime toggles in current-state annotations', () => {
    const out = collect((s) => {
      slashUsage(s as unknown as NodeJS.WritableStream, false, {
        htmlMode: true,
        tuplesOnly: true,
        expanded: 'auto',
        timing: true,
      });
    });
    expect(out).toContain('toggle HTML output mode (currently on)');
    expect(out).toContain('show only rows (currently on)');
    expect(out).toContain('toggle expanded output (currently auto)');
    expect(out).toContain('toggle timing of commands (currently on)');
  });

  it('omits the \\s line when readline is unavailable', () => {
    const out = collect((s) => {
      slashUsage(s as unknown as NodeJS.WritableStream, false, {
        useReadline: false,
      });
    });
    expect(out).not.toContain('\\s [FILE]');
  });
});

describe('slashUsage pager routing', () => {
  type PagerOpener = Parameters<typeof setHelpPagerOpener>[0];

  /** A capturing PagerHandle plus a spy opener that returns it. */
  const fakePager = (): {
    opener: Mock<Parameters<PagerOpener>, PagerHandle>;
    captured: string[];
    closed: () => boolean;
  } => {
    const captured: string[] = [];
    let didClose = false;
    const handle: PagerHandle = {
      out: {
        write(chunk: string | Uint8Array): boolean {
          captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
          return true;
        },
      } as unknown as NodeJS.WritableStream,
      spawned: true,
      close: () => {
        didClose = true;
        return Promise.resolve(0);
      },
    };
    const opener = vi.fn<Parameters<PagerOpener>, PagerHandle>(() => handle);
    return { opener, captured, closed: () => didClose };
  };

  it('routes through the pager when enabled and output is interactive', () => {
    const { opener, captured, closed } = fakePager();
    const restore = setHelpPagerOpener(opener);
    try {
      const out = new MemoryStream() as unknown as NodeJS.WriteStream;
      out.isTTY = true;
      slashUsage(out, true);
      // Nothing should have been written directly to the TTY stream...
      expect((out as unknown as MemoryStream).text()).toBe('');
      // ...the pager received the full help text instead.
      expect(opener).toHaveBeenCalledTimes(1);
      const text = captured.join('');
      expect(text).toContain('General\n');
      expect(text).toContain('\\q                     quit psql');
      expect(closed()).toBe(true);
    } finally {
      restore();
    }
  });

  it('writes inline (no pager) when output is not a TTY', () => {
    const { opener } = fakePager();
    const restore = setHelpPagerOpener(opener);
    try {
      const out = new MemoryStream();
      // pager requested, but the stream is not interactive.
      slashUsage(out as unknown as NodeJS.WritableStream, true);
      expect(opener).not.toHaveBeenCalled();
      expect(out.text()).toContain('General\n');
    } finally {
      restore();
    }
  });

  it('writes inline (no pager) when paging is disabled even on a TTY', () => {
    const { opener } = fakePager();
    const restore = setHelpPagerOpener(opener);
    try {
      const out = new MemoryStream() as unknown as NodeJS.WriteStream;
      out.isTTY = true;
      slashUsage(out, false);
      expect(opener).not.toHaveBeenCalled();
      expect((out as unknown as MemoryStream).text()).toContain('General\n');
    } finally {
      restore();
    }
  });
});

describe('helpVariables', () => {
  it('renders the default special-variables help', () => {
    expect(
      collect((s) => {
        helpVariables(s as unknown as NodeJS.WritableStream);
      }),
    ).toMatchSnapshot();
  });

  it('renders Windows-style env-var usage when win32 is set', () => {
    const out = collect((s) => {
      helpVariables(s as unknown as NodeJS.WritableStream, { win32: true });
    });
    expect(out).toContain('  set NAME=VALUE\n  psql ...');
    expect(out).not.toContain('PSQL_WATCH_PAGER');
  });
});

describe('slashUsageHelp', () => {
  it('routes "commands" to slashUsage', () => {
    const a = collect((s) => {
      slashUsageHelp(s as unknown as NodeJS.WritableStream, 'commands');
    });
    const b = collect((s) => {
      slashUsage(s as unknown as NodeJS.WritableStream, false);
    });
    expect(a).toBe(b);
  });

  it('routes "options" to usage', () => {
    const a = collect((s) => {
      slashUsageHelp(s as unknown as NodeJS.WritableStream, 'options');
    });
    const b = collect((s) => {
      usage(s as unknown as NodeJS.WritableStream);
    });
    expect(a).toBe(b);
  });

  it('routes "variables" to helpVariables', () => {
    const a = collect((s) => {
      slashUsageHelp(s as unknown as NodeJS.WritableStream, 'variables');
    });
    const b = collect((s) => {
      helpVariables(s as unknown as NodeJS.WritableStream);
    });
    expect(a).toBe(b);
  });
});

describe('helpSQL', () => {
  it('renders a column-formatted command list when no topic is given', () => {
    const out = collect((s) => {
      helpSQL(s as unknown as NodeJS.WritableStream, null, 80);
    });
    expect(out).toMatchSnapshot();
    // Sanity-check a handful of commands are present in the index.
    expect(out).toContain('Available help:');
    expect(out).toContain('SELECT');
    expect(out).toContain('CREATE TABLE');
    expect(out).toContain('DROP DATABASE');
    expect(out).toContain('GRANT');
  });

  it('treats whitespace-only topic as "no topic"', () => {
    const out = collect((s) => {
      helpSQL(s as unknown as NodeJS.WritableStream, '   ', 80);
    });
    expect(out).toContain('Available help:');
  });

  it('renders the SELECT synopsis for `\\h SELECT`', () => {
    const out = collect((s) => {
      helpSQL(s as unknown as NodeJS.WritableStream, 'SELECT', 80);
    });
    expect(out).toMatchSnapshot();
    expect(out).toContain('Command:     SELECT');
    expect(out).toContain('Description: retrieve rows from a table or view');
    expect(out).toContain('Syntax:');
    expect(out).toContain(
      'URL: https://www.postgresql.org/docs/current/sql-select.html',
    );
  });

  it('matches case-insensitively', () => {
    const upper = collect((s) => {
      helpSQL(s as unknown as NodeJS.WritableStream, 'SELECT', 80);
    });
    const lower = collect((s) => {
      helpSQL(s as unknown as NodeJS.WritableStream, 'select', 80);
    });
    const mixed = collect((s) => {
      helpSQL(s as unknown as NodeJS.WritableStream, 'SeLeCt', 80);
    });
    expect(lower).toBe(upper);
    expect(mixed).toBe(upper);
  });

  it('renders a full block per match for ambiguous prefix `\\h CREATE T`', () => {
    const out = collect((s) => {
      helpSQL(s as unknown as NodeJS.WritableStream, 'CREATE T', 80);
    });
    // psql prints the full synopsis of every prefix match, not a name list.
    expect(out).not.toContain('Several matches');
    expect(out).toContain('Command:     CREATE TABLE');
    expect(out).toContain('Command:     CREATE TRIGGER');
    expect(out).toContain('Command:     CREATE TYPE');
    // Each block carries its Syntax/URL detail.
    expect(out).toContain('Syntax:');
    // CREATE FUNCTION starts with F, not T, so must not appear here.
    expect(out).not.toContain('Command:     CREATE FUNCTION');
  });

  it('emits the "no help" message for an unknown topic', () => {
    const out = collect((s) => {
      helpSQL(s as unknown as NodeJS.WritableStream, 'bogus', 80);
    });
    expect(out).toContain('No help available for "bogus".');
    expect(out).toContain('Try \\h with no arguments to see available help.');
  });

  it('matches a two-word prefix `\\h create p` (PROCEDURE/POLICY/PUBLICATION)', () => {
    const out = collect((s) => {
      helpSQL(s as unknown as NodeJS.WritableStream, 'create p', 80);
    });
    expect(out).not.toContain('Several matches');
    expect(out).toContain('Command:     CREATE PROCEDURE');
    expect(out).toContain('Command:     CREATE POLICY');
    expect(out).toContain('Command:     CREATE PUBLICATION');
  });

  it('resolves to a single entry when the full multi-word name is given', () => {
    const out = collect((s) => {
      helpSQL(s as unknown as NodeJS.WritableStream, 'create table', 80);
    });
    expect(out).toContain('Command:     CREATE TABLE');
    expect(out).not.toContain('Several matches');
  });

  it('narrows column count when the screen is too narrow for the default layout', () => {
    const wide = collect((s) => {
      helpSQL(s as unknown as NodeJS.WritableStream, null, 120);
    });
    const narrow = collect((s) => {
      helpSQL(s as unknown as NodeJS.WritableStream, null, 30);
    });
    // Same set of commands, but the narrow output has more newlines.
    const newlines = (s: string): number => s.split('\n').length;
    expect(newlines(narrow)).toBeGreaterThan(newlines(wide));
  });
});
