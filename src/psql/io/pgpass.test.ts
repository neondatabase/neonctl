import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultPgPassPath, loadPgPass, lookupPgPass } from './pgpass.js';
import type { PgPassEntry } from './pgpass.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'psql-pgpass-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const tmpFile = (name = `pgpass-${randomUUID()}`): string =>
  path.join(tmpDir, name);

const writePgpass = async (
  file: string,
  body: string,
  mode = 0o600,
): Promise<void> => {
  await fs.writeFile(file, body, { encoding: 'utf8', mode });
};

/**
 * Capture stderr writes for the duration of the callback. Returns the
 * concatenated buffer.
 */
type Sink = NodeJS.WritableStream & { captured: () => string };
const captureStderr = (): Sink => {
  const chunks: string[] = [];
  const sink = {
    write(chunk: string | Uint8Array): boolean {
      chunks.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
      );
      return true;
    },
    captured(): string {
      return chunks.join('');
    },
  } as unknown as Sink;
  return sink;
};

describe('defaultPgPassPath', () => {
  it('honors $PGPASSFILE when non-empty', () => {
    expect(defaultPgPassPath({ PGPASSFILE: '/var/tmp/custom.pgpass' })).toBe(
      '/var/tmp/custom.pgpass',
    );
  });

  it('ignores an empty $PGPASSFILE and falls back to $HOME', () => {
    expect(defaultPgPassPath({ PGPASSFILE: '', HOME: '/home/u' })).toBe(
      path.join('/home/u', '.pgpass'),
    );
  });

  it('uses $HOME on POSIX-style environments', () => {
    expect(defaultPgPassPath({ HOME: '/home/u' })).toBe(
      path.join('/home/u', '.pgpass'),
    );
  });

  it('falls back to os.homedir() when $HOME is unset', () => {
    const got = defaultPgPassPath({});
    expect(got.endsWith('.pgpass') || got.endsWith('pgpass.conf')).toBe(true);
  });
});

describe('loadPgPass — file discovery', () => {
  it('returns [] when the file is missing', async () => {
    const out = await loadPgPass(tmpFile());
    expect(out).toEqual([]);
  });

  it('returns [] for an empty file', async () => {
    const p = tmpFile();
    await writePgpass(p, '');
    expect(await loadPgPass(p)).toEqual([]);
  });

  it('uses defaultPgPassPath when no path is given', async () => {
    // We can't easily redirect $HOME here without leaking it into other
    // tests, so verify the call is type-safe by passing an explicit env
    // with a non-existent dir.
    const out = await loadPgPass(undefined, {
      env: { HOME: tmpDir, PGPASSFILE: tmpFile('does-not-exist') },
    });
    expect(out).toEqual([]);
  });
});

describe('loadPgPass — parsing', () => {
  it('parses a single entry', async () => {
    const p = tmpFile();
    await writePgpass(p, 'localhost:5432:postgres:alice:s3cret\n');
    const entries = await loadPgPass(p);
    expect(entries).toEqual<PgPassEntry[]>([
      {
        host: 'localhost',
        port: '5432',
        database: 'postgres',
        user: 'alice',
        password: 's3cret',
      },
    ]);
  });

  it('parses multiple entries in order', async () => {
    const p = tmpFile();
    await writePgpass(
      p,
      ['h1:5432:db1:u1:p1', 'h2:5433:db2:u2:p2', 'h3:5434:db3:u3:p3'].join(
        '\n',
      ) + '\n',
    );
    const entries = await loadPgPass(p);
    expect(entries.map((e) => e.host)).toEqual(['h1', 'h2', 'h3']);
    expect(entries.map((e) => e.password)).toEqual(['p1', 'p2', 'p3']);
  });

  it('skips comment lines starting with #', async () => {
    const p = tmpFile();
    await writePgpass(
      p,
      [
        '# header comment',
        'localhost:5432:db:user:pw1',
        '# inline comment between entries',
        'remote:5433:db:user:pw2',
      ].join('\n') + '\n',
    );
    const entries = await loadPgPass(p);
    expect(entries.length).toBe(2);
    expect(entries[0].password).toBe('pw1');
    expect(entries[1].password).toBe('pw2');
  });

  it('skips blank lines and tolerates leading whitespace', async () => {
    const p = tmpFile();
    await writePgpass(
      p,
      ['', '   # comment', '', 'h:5432:db:u:pw', ''].join('\n'),
    );
    const entries = await loadPgPass(p);
    expect(entries.length).toBe(1);
    expect(entries[0].host).toBe('h');
  });

  it('decodes \\: and \\\\ escapes within fields', async () => {
    const p = tmpFile();
    // Password is literally "p:a\\ss" — encoded as p\:a\\ss in the file.
    await writePgpass(p, 'host:5432:db:user:p\\:a\\\\ss\n');
    const entries = await loadPgPass(p);
    expect(entries[0].password).toBe('p:a\\ss');
  });

  it('drops malformed entries (wrong number of fields) silently', async () => {
    const p = tmpFile();
    await writePgpass(
      p,
      ['only:three:fields', 'h:5432:db:u:pw', 'one'].join('\n') + '\n',
    );
    const entries = await loadPgPass(p);
    expect(entries.length).toBe(1);
    expect(entries[0].host).toBe('h');
  });

  it('tolerates CRLF line endings', async () => {
    const p = tmpFile();
    await writePgpass(p, 'h1:5432:db:u:pw1\r\nh2:5432:db:u:pw2\r\n');
    const entries = await loadPgPass(p);
    expect(entries.map((e) => e.host)).toEqual(['h1', 'h2']);
  });
});

describe('loadPgPass — permissions (POSIX)', () => {
  it('skips a file with group-read bits set and warns once', async () => {
    if (process.platform === 'win32') return;
    const p = tmpFile();
    await writePgpass(p, 'h:5432:db:u:pw\n', 0o644);
    const stderr = captureStderr();
    const entries = await loadPgPass(p, { stderr });
    expect(entries).toEqual([]);
    expect(stderr.captured()).toMatch(/WARNING.*group or world access/);
    expect(stderr.captured()).toMatch(p);
  });

  it('skips a file with world-read bits set and warns once', async () => {
    if (process.platform === 'win32') return;
    const p = tmpFile();
    await writePgpass(p, 'h:5432:db:u:pw\n', 0o604);
    const stderr = captureStderr();
    const entries = await loadPgPass(p, { stderr });
    expect(entries).toEqual([]);
    expect(stderr.captured()).toMatch(/WARNING/);
  });

  it('accepts a file with mode 0600', async () => {
    if (process.platform === 'win32') return;
    const p = tmpFile();
    await writePgpass(p, 'h:5432:db:u:pw\n', 0o600);
    const stderr = captureStderr();
    const entries = await loadPgPass(p, { stderr });
    expect(entries.length).toBe(1);
    expect(stderr.captured()).toBe('');
  });
});

describe('lookupPgPass', () => {
  const entries: PgPassEntry[] = [
    {
      host: 'specific',
      port: '5432',
      database: 'mydb',
      user: 'alice',
      password: 'specific-pw',
    },
    {
      host: '*',
      port: '*',
      database: '*',
      user: 'alice',
      password: 'alice-fallback',
    },
    {
      host: '*',
      port: '*',
      database: '*',
      user: '*',
      password: 'catch-all',
    },
  ];

  it('returns the first specific match', () => {
    expect(
      lookupPgPass(entries, {
        host: 'specific',
        port: 5432,
        database: 'mydb',
        user: 'alice',
      }),
    ).toBe('specific-pw');
  });

  it('treats an escaped \\* field as a literal, not a wildcard (review #21)', () => {
    const escaped: PgPassEntry[] = [
      {
        host: '\\*', // raw `\*` — a literal asterisk, NOT the wildcard
        port: '5432',
        database: 'db',
        user: 'alice',
        password: 'secret',
      },
    ];
    // Must NOT match an arbitrary host (the bug returned `secret` here).
    expect(
      lookupPgPass(escaped, {
        host: 'evil.example.com',
        port: 5432,
        database: 'db',
        user: 'alice',
      }),
    ).toBeUndefined();
    // Still matches a host literally named `*`.
    expect(
      lookupPgPass(escaped, {
        host: '*',
        port: 5432,
        database: 'db',
        user: 'alice',
      }),
    ).toBe('secret');
  });

  it('honors wildcard fields when specifics do not match', () => {
    expect(
      lookupPgPass(entries, {
        host: 'other',
        port: 5432,
        database: 'mydb',
        user: 'alice',
      }),
    ).toBe('alice-fallback');
  });

  it('falls through to a wildcard-user entry when prior rules do not match', () => {
    expect(
      lookupPgPass(entries, {
        host: 'other',
        port: 5432,
        database: 'mydb',
        user: 'bob',
      }),
    ).toBe('catch-all');
  });

  it('returns undefined when nothing matches', () => {
    expect(
      lookupPgPass(
        [
          {
            host: 'h',
            port: '5432',
            database: 'db',
            user: 'u',
            password: 'pw',
          },
        ],
        { host: 'other', port: 5432, database: 'db', user: 'u' },
      ),
    ).toBeUndefined();
  });

  it('compares port as a string against numeric target', () => {
    const e: PgPassEntry[] = [
      {
        host: 'h',
        port: '5433',
        database: 'd',
        user: 'u',
        password: 'pw',
      },
    ];
    expect(
      lookupPgPass(e, { host: 'h', port: 5433, database: 'd', user: 'u' }),
    ).toBe('pw');
    expect(
      lookupPgPass(e, { host: 'h', port: 5432, database: 'd', user: 'u' }),
    ).toBeUndefined();
  });

  it('honors first-match precedence (top-of-file wins)', () => {
    const e: PgPassEntry[] = [
      {
        host: 'h',
        port: '5432',
        database: 'd',
        user: 'u',
        password: 'first',
      },
      {
        host: 'h',
        port: '5432',
        database: 'd',
        user: 'u',
        password: 'second',
      },
    ];
    expect(
      lookupPgPass(e, { host: 'h', port: 5432, database: 'd', user: 'u' }),
    ).toBe('first');
  });
});
