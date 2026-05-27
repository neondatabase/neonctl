import { describe, it, expect } from 'vitest';
import { defaultRules, normalize, type NormalizeRule } from './normalize.js';

describe('normalize: per-rule coverage', () => {
  it('crlf-to-lf collapses Windows line endings', () => {
    expect(normalize('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('psql-banner-version masks the version inside parentheses', () => {
    expect(normalize('psql (17.4)\n')).toBe('psql (PG_VERSION)\n');
    expect(normalize('psql (17.4 (Debian 17.4-1.pgdg120+1))\n')).toBe(
      'psql (PG_VERSION)\n',
    );
  });

  it('server-version-line masks the server version on its own line', () => {
    expect(normalize('server version: 17.4 (Debian)\n')).toBe(
      'server version: PG_VERSION (Debian)\n',
    );
  });

  it('conninfo-host-port masks double-quoted host/port', () => {
    expect(
      normalize(
        'You are connected to database "postgres" on host "127.0.0.1" at port "54931".\n',
      ),
    ).toBe(
      'You are connected to database "postgres" on host "HOST" at port "PORT".\n',
    );
  });

  it('conninfo-host-port masks single-quoted host/port', () => {
    expect(normalize("on host 'localhost' at port '5432'")).toBe(
      "on host 'HOST' at port 'PORT'",
    );
  });

  it('iso-timestamp masks PG and ISO-8601 timestamp shapes', () => {
    expect(normalize('NOTICE:  fired at 2026-05-25 14:23:10.456 UTC')).toBe(
      'NOTICE:  fired at TIMESTAMP',
    );
    expect(normalize('LOG:  2026-05-25T14:23:10.456Z something')).toBe(
      'LOG:  TIMESTAMP something',
    );
    expect(normalize('2026-05-25 14:23:10 +00:00 foo')).toBe('TIMESTAMP foo');
  });

  it('notice-pid masks bracketed pids in NOTICE prefixes', () => {
    expect(normalize('NOTICE:  [12345]: oops')).toBe('NOTICE:  [PID]: oops');
  });

  it('pg-share-path masks all known share-dir variants', () => {
    const samples = [
      '/usr/local/pgsql/share',
      '/usr/share/postgresql',
      '/usr/share/postgresql/17',
      '/Library/PostgreSQL/17/share',
      '/opt/homebrew/share/postgresql@17',
      '/opt/local/share/postgresql17',
    ];
    for (const s of samples) {
      expect(normalize(s)).toBe('PGSHAREDIR');
    }
  });

  it('regress-abs-builddir masks the psql-conformance-regress prefix', () => {
    expect(
      normalize(
        '/var/folders/00/g7cppbgs2lx0h9flgt7f9fn40000gp/T/psql-conformance-regress-8u8tye/results/psql-output1',
      ),
    ).toBe('ABS_BUILDDIR/results/psql-output1');
    expect(
      normalize('/tmp/psql-conformance-regress-abc123/results/psql-output1'),
    ).toBe('ABS_BUILDDIR/results/psql-output1');
  });

  it('regress-abs-builddir-mktemp-darwin masks /var/folders/.../T/tmp.* dirs', () => {
    expect(
      normalize(
        '/var/folders/00/g7cppbgs2lx0h9flgt7f9fn40000gp/T/tmp.AbCdEf12/results/foo',
      ),
    ).toBe('ABS_BUILDDIR/results/foo');
  });

  it('regress-abs-builddir-mktemp-linux masks bare /tmp/tmp.* dirs', () => {
    expect(normalize('/tmp/tmp.XYZ987/results/foo')).toBe(
      'ABS_BUILDDIR/results/foo',
    );
  });
});

describe('normalize: composition', () => {
  it('applies rules in order', () => {
    const input =
      'psql (17.4)\r\nYou are connected to database "x" on host "h" at port "5432".\r\nNOTICE:  fired at 2026-05-25 14:23:10 UTC\r\n';
    const expected =
      'psql (PG_VERSION)\nYou are connected to database "x" on host "HOST" at port "PORT".\nNOTICE:  fired at TIMESTAMP\n';
    expect(normalize(input)).toBe(expected);
  });

  it('passes through text with no matches unchanged', () => {
    const input = 'SELECT 1;\n one\n---\n   1\n(1 row)\n\n';
    expect(normalize(input)).toBe(input);
  });

  it('accepts a custom rule set that overrides defaults', () => {
    const rules: NormalizeRule[] = [
      { name: 'mask-digits', pattern: /\d+/g, replacement: 'N' },
    ];
    // The default version-banner rule would NOT apply here.
    expect(normalize('psql (17.4)', rules)).toBe('psql (N.N)');
  });

  it('defaultRules is non-empty (sanity)', () => {
    expect(defaultRules.length).toBeGreaterThan(0);
  });
});
