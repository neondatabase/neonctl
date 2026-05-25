import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  appendHistory,
  defaultHistoryPath,
  loadHistory,
  resolveHistSize,
  truncateHistory,
} from './history.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'psql-history-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const tmpFile = (name = `hist-${randomUUID()}`): string =>
  path.join(tmpDir, name);

describe('loadHistory', () => {
  it('returns [] when the file is missing', async () => {
    const result = await loadHistory(tmpFile());
    expect(result).toEqual([]);
  });

  it('returns [] for an empty file', async () => {
    const p = tmpFile();
    await fs.writeFile(p, '', 'utf8');
    expect(await loadHistory(p)).toEqual([]);
  });

  it('decodes \\n, \\r, and \\\\ escapes', async () => {
    const p = tmpFile();
    // On disk: three entries — multi-line SELECT, plain SELECT, path w/ backslash.
    await fs.writeFile(
      p,
      ['SELECT 1\\n  FROM t;', 'SELECT 2;', 'C:\\\\Users\\\\x'].join('\n') +
        '\n',
      'utf8',
    );
    const entries = await loadHistory(p);
    expect(entries).toEqual([
      'SELECT 1\n  FROM t;',
      'SELECT 2;',
      'C:\\Users\\x',
    ]);
  });

  it('skips lines starting with # (libreadline timestamp markers)', async () => {
    const p = tmpFile();
    await fs.writeFile(
      p,
      ['#1715000000', 'SELECT 1;', '#1715000050', 'SELECT 2;'].join('\n') +
        '\n',
      'utf8',
    );
    expect(await loadHistory(p)).toEqual(['SELECT 1;', 'SELECT 2;']);
  });

  it('does not produce a phantom empty entry from a trailing newline', async () => {
    const p = tmpFile();
    await fs.writeFile(p, 'SELECT 1;\n', 'utf8');
    expect(await loadHistory(p)).toEqual(['SELECT 1;']);
  });
});

describe('appendHistory', () => {
  it('encodes newlines, CRs and backslashes when writing', async () => {
    const p = tmpFile();
    await appendHistory(p, 'SELECT 1\n  FROM t;');
    await appendHistory(p, 'C:\\Users\\x');
    const raw = await fs.readFile(p, 'utf8');
    expect(raw).toBe('SELECT 1\\n  FROM t;\nC:\\\\Users\\\\x\n');
  });

  it('round-trips multi-line entries via loadHistory', async () => {
    const p = tmpFile();
    const entries = [
      'SELECT 1;',
      'SELECT *\n  FROM t\n  WHERE x = 1;',
      'echo "a\\b"',
      '\\\\d',
    ];
    for (const e of entries) await appendHistory(p, e);
    expect(await loadHistory(p)).toEqual(entries);
  });

  describe('HISTCONTROL', () => {
    it('none: always appends, including dups and leading-space lines', async () => {
      const p = tmpFile();
      await appendHistory(p, 'SELECT 1;', 'none');
      await appendHistory(p, 'SELECT 1;', 'none');
      await appendHistory(p, '  SELECT 2;', 'none');
      expect(await loadHistory(p)).toEqual([
        'SELECT 1;',
        'SELECT 1;',
        '  SELECT 2;',
      ]);
    });

    it('ignorespace: drops entries starting with whitespace', async () => {
      const p = tmpFile();
      await appendHistory(p, 'SELECT 1;', 'ignorespace');
      await appendHistory(p, '  SELECT 2;', 'ignorespace');
      await appendHistory(p, '\tSELECT 3;', 'ignorespace');
      await appendHistory(p, 'SELECT 4;', 'ignorespace');
      expect(await loadHistory(p)).toEqual(['SELECT 1;', 'SELECT 4;']);
    });

    it('ignoredups: drops if equal to the previous entry', async () => {
      const p = tmpFile();
      await appendHistory(p, 'SELECT 1;', 'ignoredups');
      await appendHistory(p, 'SELECT 1;', 'ignoredups');
      await appendHistory(p, 'SELECT 2;', 'ignoredups');
      await appendHistory(p, 'SELECT 2;', 'ignoredups');
      await appendHistory(p, 'SELECT 1;', 'ignoredups');
      expect(await loadHistory(p)).toEqual([
        'SELECT 1;',
        'SELECT 2;',
        'SELECT 1;',
      ]);
    });

    it('ignoreboth: applies both filters', async () => {
      const p = tmpFile();
      await appendHistory(p, 'SELECT 1;', 'ignoreboth');
      await appendHistory(p, '  SELECT 2;', 'ignoreboth');
      await appendHistory(p, 'SELECT 1;', 'ignoreboth');
      await appendHistory(p, 'SELECT 1;', 'ignoreboth');
      await appendHistory(p, ' SELECT 3;', 'ignoreboth');
      await appendHistory(p, 'SELECT 4;', 'ignoreboth');
      expect(await loadHistory(p)).toEqual(['SELECT 1;', 'SELECT 4;']);
    });

    it('ignoredups compares on the raw decoded entry across reloads', async () => {
      const p = tmpFile();
      await appendHistory(p, 'SELECT 1\n  FROM t;', 'ignoredups');
      await appendHistory(p, 'SELECT 1\n  FROM t;', 'ignoredups');
      expect(await loadHistory(p)).toEqual(['SELECT 1\n  FROM t;']);
    });
  });
});

describe('truncateHistory', () => {
  it('is a no-op when the file already fits', async () => {
    const p = tmpFile();
    for (const i of [1, 2, 3]) await appendHistory(p, `SELECT ${i};`);
    const before = await fs.readFile(p, 'utf8');
    await truncateHistory(p, 10);
    expect(await fs.readFile(p, 'utf8')).toBe(before);
  });

  it('keeps the last N entries in order', async () => {
    const p = tmpFile();
    for (let i = 1; i <= 7; i++) await appendHistory(p, `SELECT ${i};`);
    await truncateHistory(p, 3);
    expect(await loadHistory(p)).toEqual([
      'SELECT 5;',
      'SELECT 6;',
      'SELECT 7;',
    ]);
  });

  it('preserves multi-line entry encoding through truncation', async () => {
    const p = tmpFile();
    await appendHistory(p, 'SELECT 1;');
    await appendHistory(p, 'SELECT 2\nFROM t;');
    await appendHistory(p, 'C:\\Users\\x');
    await truncateHistory(p, 2);
    expect(await loadHistory(p)).toEqual(['SELECT 2\nFROM t;', 'C:\\Users\\x']);
    // On-disk form must still use literal escapes, not real newlines.
    const raw = await fs.readFile(p, 'utf8');
    expect(raw).toBe('SELECT 2\\nFROM t;\nC:\\\\Users\\\\x\n');
  });

  it('removes the file when maxLines <= 0', async () => {
    const p = tmpFile();
    await appendHistory(p, 'SELECT 1;');
    await truncateHistory(p, 0);
    await expect(fs.access(p)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is a no-op on a missing file', async () => {
    const p = tmpFile();
    await truncateHistory(p, 100);
    await expect(fs.access(p)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('defaultHistoryPath', () => {
  it('honors $PSQL_HISTORY when non-empty', () => {
    expect(defaultHistoryPath({ PSQL_HISTORY: '/var/tmp/custom.hist' })).toBe(
      '/var/tmp/custom.hist',
    );
  });

  it('ignores an empty $PSQL_HISTORY and falls back to $HOME', () => {
    expect(defaultHistoryPath({ PSQL_HISTORY: '', HOME: '/home/u' })).toBe(
      path.join('/home/u', '.psql_history'),
    );
  });

  it('uses $HOME on POSIX-style environments', () => {
    expect(defaultHistoryPath({ HOME: '/home/u' })).toBe(
      path.join('/home/u', '.psql_history'),
    );
  });

  it('uses %APPDATA% on Windows', () => {
    if (process.platform !== 'win32') return;
    expect(defaultHistoryPath({ APPDATA: 'C:\\Users\\u\\AppData' })).toBe(
      path.join('C:\\Users\\u\\AppData', 'postgresql', 'psql_history'),
    );
  });

  it('falls back to os.homedir() when $HOME is unset', () => {
    const got = defaultHistoryPath({});
    // We can't assert an exact path, but it should end with .psql_history
    // (POSIX) or psql_history (Windows fallback paths).
    expect(got.endsWith('.psql_history') || got.endsWith('psql_history')).toBe(
      true,
    );
  });
});

describe('resolveHistSize', () => {
  it('returns the psql default (500) when HISTSIZE is unset', () => {
    expect(resolveHistSize({})).toBe(500);
  });

  it('parses a non-negative integer HISTSIZE', () => {
    expect(resolveHistSize({ HISTSIZE: '1000' })).toBe(1000);
    expect(resolveHistSize({ HISTSIZE: '0' })).toBe(0);
  });

  it('falls back to the default for malformed HISTSIZE', () => {
    expect(resolveHistSize({ HISTSIZE: 'lots' })).toBe(500);
    expect(resolveHistSize({ HISTSIZE: '-5' })).toBe(500);
    expect(resolveHistSize({ HISTSIZE: '1.5' })).toBe(500);
    expect(resolveHistSize({ HISTSIZE: '' })).toBe(500);
  });
});
