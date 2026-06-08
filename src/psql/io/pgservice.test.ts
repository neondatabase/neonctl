import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultPgServiceFilePath,
  loadPgServices,
  lookupService,
  parsePgServiceContent,
} from './pgservice.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'psql-pgservice-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const tmpFile = (name = `svc-${randomUUID()}`): string =>
  path.join(tmpDir, name);

describe('defaultPgServiceFilePath', () => {
  it('puts $PGSERVICEFILE at the front of the list when set', () => {
    const paths = defaultPgServiceFilePath({
      PGSERVICEFILE: '/tmp/custom-pg_service.conf',
      HOME: '/home/u',
    });
    expect(paths[0]).toBe('/tmp/custom-pg_service.conf');
  });

  it('includes ~/.pg_service.conf when $HOME is set (POSIX)', () => {
    if (process.platform === 'win32') return;
    const paths = defaultPgServiceFilePath({ HOME: '/home/u' });
    expect(paths).toContain(path.join('/home/u', '.pg_service.conf'));
  });

  it('includes $PGSYSCONFDIR/pg_service.conf when set', () => {
    const paths = defaultPgServiceFilePath({
      HOME: '/home/u',
      PGSYSCONFDIR: '/etc/postgresql',
    });
    expect(paths).toContain(path.join('/etc/postgresql', 'pg_service.conf'));
  });

  it('ends with /etc/pg_service.conf on POSIX as the final fallback', () => {
    if (process.platform === 'win32') return;
    const paths = defaultPgServiceFilePath({ HOME: '/home/u' });
    expect(paths[paths.length - 1]).toBe('/etc/pg_service.conf');
  });

  it('omits empty $PGSERVICEFILE', () => {
    const paths = defaultPgServiceFilePath({
      PGSERVICEFILE: '',
      HOME: '/home/u',
    });
    expect(paths).not.toContain('');
  });
});

describe('parsePgServiceContent — basic parsing', () => {
  it('parses a single section', () => {
    const services = parsePgServiceContent(
      [
        '[primary]',
        'host=db.example.com',
        'port=5432',
        'dbname=mydb',
        'user=myuser',
      ].join('\n'),
    );
    expect(services.size).toBe(1);
    expect(services.get('primary')).toEqual({
      host: 'db.example.com',
      port: '5432',
      dbname: 'mydb',
      user: 'myuser',
    });
  });

  it('parses multiple sections with independent params', () => {
    const services = parsePgServiceContent(
      [
        '[primary]',
        'host=p.example.com',
        'port=5432',
        '',
        '[replica]',
        'host=r.example.com',
        'port=5433',
      ].join('\n'),
    );
    expect(services.size).toBe(2);
    expect(services.get('primary')?.host).toBe('p.example.com');
    expect(services.get('replica')?.host).toBe('r.example.com');
  });

  it('skips comment lines starting with #', () => {
    const services = parsePgServiceContent(
      [
        '# top of file',
        '[svc]',
        '# inline comment',
        'host=h1',
        '# trailing comment',
      ].join('\n'),
    );
    expect(services.get('svc')).toEqual({ host: 'h1' });
  });

  it('tolerates blank lines and whitespace-only lines', () => {
    const services = parsePgServiceContent(
      ['', '   ', '[svc]', '', 'host=h1', '   ', 'port=5432'].join('\n'),
    );
    expect(services.get('svc')).toEqual({ host: 'h1', port: '5432' });
  });

  it('trims whitespace around keys and values', () => {
    const services = parsePgServiceContent(
      ['[svc]', '  host =   h1 ', 'port=5432'].join('\n'),
    );
    expect(services.get('svc')).toEqual({ host: 'h1', port: '5432' });
  });

  it('returns an empty map for an empty / comments-only file', () => {
    expect(parsePgServiceContent('').size).toBe(0);
    expect(parsePgServiceContent('# nothing here\n#\n').size).toBe(0);
  });

  it('ignores key=value lines that appear before any section header', () => {
    const services = parsePgServiceContent(
      ['orphan=value', '[svc]', 'host=h1'].join('\n'),
    );
    expect(services.get('svc')).toEqual({ host: 'h1' });
  });

  it('drops lines without `=` (no error)', () => {
    const services = parsePgServiceContent(
      ['[svc]', 'host=h1', 'nokeyvalue', 'port=5432'].join('\n'),
    );
    expect(services.get('svc')).toEqual({ host: 'h1', port: '5432' });
  });

  it('tolerates CRLF line endings', () => {
    const services = parsePgServiceContent('[svc]\r\nhost=h1\r\nport=5432\r\n');
    expect(services.get('svc')).toEqual({ host: 'h1', port: '5432' });
  });

  it('case-sensitive section names', () => {
    const services = parsePgServiceContent(
      ['[Foo]', 'host=h1', '[foo]', 'host=h2'].join('\n'),
    );
    expect(services.get('Foo')?.host).toBe('h1');
    expect(services.get('foo')?.host).toBe('h2');
  });
});

describe('loadPgServices — file loading', () => {
  it('returns an empty map when no candidate file exists', async () => {
    const services = await loadPgServices([tmpFile()]);
    expect(services.size).toBe(0);
  });

  it('reads the first existing file in the candidate list', async () => {
    const a = tmpFile('a');
    const b = tmpFile('b');
    await fs.writeFile(a, '[from-a]\nhost=hA\n', 'utf8');
    await fs.writeFile(b, '[from-b]\nhost=hB\n', 'utf8');
    const services = await loadPgServices([a, b]);
    expect(services.get('from-a')?.host).toBe('hA');
    expect(services.has('from-b')).toBe(false);
  });

  it('walks the candidate list and stops at the first existing file', async () => {
    const a = tmpFile('a');
    const b = tmpFile('b');
    await fs.writeFile(b, '[from-b]\nhost=hB\n', 'utf8');
    const services = await loadPgServices([a, b]);
    expect(services.get('from-b')?.host).toBe('hB');
  });
});

describe('lookupService', () => {
  it('returns the entry by name', () => {
    const services = new Map([
      ['svc1', { host: 'h1', port: '5432' }],
      ['svc2', { host: 'h2', port: '5433' }],
    ]);
    expect(lookupService(services, 'svc1')).toEqual({
      host: 'h1',
      port: '5432',
    });
  });

  it('returns undefined for missing service', () => {
    const services = new Map([['svc1', { host: 'h1' }]]);
    expect(lookupService(services, 'absent')).toBeUndefined();
  });

  it('is case-sensitive', () => {
    const services = new Map([['Svc', { host: 'h1' }]]);
    expect(lookupService(services, 'svc')).toBeUndefined();
    expect(lookupService(services, 'Svc')?.host).toBe('h1');
  });
});
