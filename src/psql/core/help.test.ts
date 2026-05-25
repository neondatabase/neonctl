import { describe, expect, it } from 'vitest';

import {
  helpSQL,
  helpVariables,
  slashUsage,
  slashUsageHelp,
  usage,
} from './help.js';

/** Minimal WritableStream stand-in that records every `.write()` call. */
class MemoryStream {
  chunks: string[] = [];
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

  it('lists matches for ambiguous prefix `\\h CREATE T`', () => {
    const out = collect((s) => {
      helpSQL(s as unknown as NodeJS.WritableStream, 'CREATE T', 80);
    });
    expect(out).toContain('Several matches for "CREATE T":');
    expect(out).toContain('  CREATE TABLE');
    expect(out).toContain('  CREATE TRIGGER');
    expect(out).toContain('  CREATE TYPE');
    // CREATE FUNCTION starts with F, not T, so must not appear here.
    expect(out).not.toContain('  CREATE FUNCTION');
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
    expect(out).toContain('Several matches for "create p":');
    expect(out).toContain('CREATE PROCEDURE');
    expect(out).toContain('CREATE POLICY');
    expect(out).toContain('CREATE PUBLICATION');
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
