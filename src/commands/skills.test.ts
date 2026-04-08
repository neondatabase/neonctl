import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

import {
  parseFrontmatter,
  parseBody,
  getInstallStatus,
  validateName,
} from './skills.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => false) };
});

const existsSyncMock = vi.mocked(existsSync);

describe('skills', () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
  });

  describe('validateName', () => {
    it('accepts valid skill names', () => {
      expect(validateName('neon-postgres')).toBe('neon-postgres');
      expect(validateName('my_skill')).toBe('my_skill');
      expect(validateName('skill.v2')).toBe('skill.v2');
      expect(validateName('a')).toBe('a');
      expect(validateName('123')).toBe('123');
    });

    it('rejects path traversal attempts', () => {
      expect(() => validateName('../../etc')).toThrow('Invalid skill name');
      expect(() => validateName('../.ssh')).toThrow('Invalid skill name');
      expect(() => validateName('foo/../bar')).toThrow('Invalid skill name');
    });

    it('rejects names starting with special characters', () => {
      expect(() => validateName('.hidden')).toThrow('Invalid skill name');
      expect(() => validateName('-flag')).toThrow('Invalid skill name');
      expect(() => validateName('_private')).toThrow('Invalid skill name');
    });

    it('rejects names with invalid characters', () => {
      expect(() => validateName('skill/name')).toThrow('Invalid skill name');
      expect(() => validateName('skill name')).toThrow('Invalid skill name');
      expect(() => validateName('UPPERCASE')).toThrow('Invalid skill name');
      expect(() => validateName('')).toThrow('Invalid skill name');
    });
  });

  describe('parseFrontmatter', () => {
    it('parses all frontmatter fields', () => {
      const content = [
        '---',
        'name: my-skill',
        'description: A test skill',
        'compatibility: node >= 18',
        'license: MIT',
        '---',
        'Body content here',
      ].join('\n');

      expect(parseFrontmatter(content)).toEqual({
        name: 'my-skill',
        description: 'A test skill',
        compatibility: 'node >= 18',
        license: 'MIT',
      });
    });

    it('handles quoted values', () => {
      const content = [
        '---',
        'name: "quoted-skill"',
        "description: 'single quoted'",
        '---',
      ].join('\n');

      expect(parseFrontmatter(content)).toEqual({
        name: 'quoted-skill',
        description: 'single quoted',
        compatibility: undefined,
        license: undefined,
      });
    });

    it('returns defaults when no frontmatter present', () => {
      expect(parseFrontmatter('Just some content')).toEqual({
        name: '',
        description: '',
        compatibility: undefined,
        license: undefined,
      });
    });

    it('returns defaults for empty frontmatter', () => {
      const content = '---\n---\nBody';
      expect(parseFrontmatter(content)).toEqual({
        name: '',
        description: '',
        compatibility: undefined,
        license: undefined,
      });
    });

    it('handles colons in values', () => {
      const content = [
        '---',
        'name: my-skill',
        'description: A skill: with colons: in it',
        '---',
      ].join('\n');

      expect(parseFrontmatter(content)).toEqual({
        name: 'my-skill',
        description: 'A skill: with colons: in it',
        compatibility: undefined,
        license: undefined,
      });
    });

    it('ignores lines without colons', () => {
      const content = ['---', 'name: my-skill', 'not a key value', '---'].join(
        '\n',
      );

      expect(parseFrontmatter(content).name).toBe('my-skill');
    });

    it('handles \\r\\n line endings', () => {
      const content =
        '---\r\nname: my-skill\r\ndescription: A test\r\n---\r\nBody';
      expect(parseFrontmatter(content)).toEqual({
        name: 'my-skill',
        description: 'A test',
        compatibility: undefined,
        license: undefined,
      });
    });
  });

  describe('parseBody', () => {
    it('extracts body after frontmatter', () => {
      const content = '---\nname: test\n---\nBody content here';
      expect(parseBody(content)).toBe('Body content here');
    });

    it('trims whitespace from body', () => {
      const content = '---\nname: test\n---\n\n  Body  \n\n';
      expect(parseBody(content)).toBe('Body');
    });

    it('returns full content when no frontmatter', () => {
      expect(parseBody('Just content')).toBe('Just content');
    });

    it('handles multiline body', () => {
      const content = '---\nname: test\n---\nLine 1\nLine 2\nLine 3';
      expect(parseBody(content)).toBe('Line 1\nLine 2\nLine 3');
    });

    it('handles empty body after frontmatter', () => {
      const content = '---\nname: test\n---\n';
      expect(parseBody(content)).toBe('');
    });

    it('handles \\r\\n line endings', () => {
      const content = '---\r\nname: test\r\n---\r\nBody content here';
      expect(parseBody(content)).toBe('Body content here');
    });
  });

  describe('getInstallStatus', () => {
    it('returns empty string when not installed', () => {
      expect(getInstallStatus('my-skill')).toBe('');
    });

    it('returns "local" when installed locally', () => {
      existsSyncMock.mockImplementation(
        (path) =>
          path ===
          resolve(join(process.cwd(), '.agents', 'skills', 'my-skill')),
      );
      expect(getInstallStatus('my-skill')).toBe('local');
    });

    it('returns "global" when installed globally', () => {
      existsSyncMock.mockImplementation(
        (path) =>
          path === resolve(join(homedir(), '.agents', 'skills', 'my-skill')),
      );
      expect(getInstallStatus('my-skill')).toBe('global');
    });

    it('returns "local, global" when installed in both locations', () => {
      existsSyncMock.mockReturnValue(true);
      expect(getInstallStatus('my-skill')).toBe('local, global');
    });

    it('returns empty string for invalid names instead of throwing', () => {
      expect(getInstallStatus('../../etc')).toBe('');
    });
  });
});
