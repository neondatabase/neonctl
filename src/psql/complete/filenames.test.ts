import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { completeFilenames, isCopyFromOrTo } from './filenames.js';

describe('completeFilenames', () => {
  // Layout:
  //   <work>/
  //     tab_comp_dir/
  //       afile123
  //       afile456
  //       somefile
  //     other.txt
  //     nested/
  //       sub.sql
  let work: string;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'psql-complete-fn-'));
    const dir = join(work, 'tab_comp_dir');
    mkdirSync(dir);
    writeFileSync(join(dir, 'afile123'), '1');
    writeFileSync(join(dir, 'afile456'), '2');
    writeFileSync(join(dir, 'somefile'), '3');
    writeFileSync(join(work, 'other.txt'), 'x');
    mkdirSync(join(work, 'nested'));
    writeFileSync(join(work, 'nested', 'sub.sql'), 'y');
  });

  afterAll(() => {
    // Best-effort cleanup — leftover tmp dirs are harmless on POSIX.
  });

  describe('quoteCtx="none"', () => {
    it('returns the unique full path for a single-file prefix', () => {
      const out = completeFilenames('tab_comp_dir/some', 'none', work);
      expect(out).toEqual(['tab_comp_dir/somefile']);
    });

    it('returns all matching files for an ambiguous prefix', () => {
      const out = completeFilenames('tab_comp_dir/af', 'none', work);
      expect(out).toEqual(['tab_comp_dir/afile123', 'tab_comp_dir/afile456']);
    });

    it('lists every entry when the prefix ends at a directory boundary', () => {
      const out = completeFilenames('tab_comp_dir/', 'none', work);
      expect(out).toEqual([
        'tab_comp_dir/afile123',
        'tab_comp_dir/afile456',
        'tab_comp_dir/somefile',
      ]);
    });

    it('adds a trailing slash to directory candidates', () => {
      const out = completeFilenames('tab', 'none', work);
      expect(out).toEqual(['tab_comp_dir/']);
    });

    it('returns empty when no entries match', () => {
      const out = completeFilenames('tab_comp_dir/no_such', 'none', work);
      expect(out).toEqual([]);
    });

    it('returns empty when the dir does not exist', () => {
      const out = completeFilenames('does_not_exist/foo', 'none', work);
      expect(out).toEqual([]);
    });
  });

  describe('quoteCtx="sql"', () => {
    it('wraps unique candidate in single quotes (closed)', () => {
      const out = completeFilenames('tab_comp_dir/some', 'sql', work);
      expect(out).toEqual(["'tab_comp_dir/somefile'"]);
    });

    it('wraps multi-candidates with open-only quote', () => {
      const out = completeFilenames('tab_comp_dir/af', 'sql', work);
      expect(out).toEqual(["'tab_comp_dir/afile123", "'tab_comp_dir/afile456"]);
    });

    it('preserves an opening single quote the user already typed', () => {
      // When the user is already inside a `'...` literal, the tokenizer
      // hands us the opening quote inside currentWord. We strip it for
      // the filesystem lookup and re-add it to the candidates.
      const out = completeFilenames("'tab_comp_dir/some", 'sql', work);
      expect(out).toEqual(["'tab_comp_dir/somefile'"]);
    });

    it('leaves quotes open for directory candidates (keep typing)', () => {
      const out = completeFilenames('tab', 'sql', work);
      // Directory match — closing quote suppressed so the user keeps
      // typing through the trailing slash.
      expect(out).toEqual(["'tab_comp_dir/"]);
    });
  });
});

describe('isCopyFromOrTo', () => {
  it('returns true for `COPY x FROM`', () => {
    expect(isCopyFromOrTo(['COPY', 'x', 'FROM'])).toBe(true);
  });

  it('returns true for `COPY x TO` (lowercase)', () => {
    expect(isCopyFromOrTo(['copy', 'x', 'to'])).toBe(true);
  });

  it('returns false when the trailing word is not FROM/TO', () => {
    expect(isCopyFromOrTo(['COPY', 'x'])).toBe(false);
  });

  it('returns false outside a COPY statement', () => {
    // `SELECT … FROM` is not a filename context.
    expect(isCopyFromOrTo(['SELECT', '*', 'FROM'])).toBe(false);
  });

  it('returns false for a bare FROM with no COPY', () => {
    expect(isCopyFromOrTo(['FROM'])).toBe(false);
  });
});
