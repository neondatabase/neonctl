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
  it('emits the placeholder overview when no topic is given', () => {
    const out = collect((s) => {
      helpSQL(s as unknown as NodeJS.WritableStream, null, 80);
    });
    expect(out).toContain('Available help:');
    expect(out).toContain('not yet implemented');
  });

  it('emits the "no help" message for an unknown topic', () => {
    const out = collect((s) => {
      helpSQL(s as unknown as NodeJS.WritableStream, 'SELECT', 80);
    });
    expect(out).toContain('No help available for "SELECT".');
    expect(out).toContain('Try \\h with no arguments to see available help.');
  });
});
