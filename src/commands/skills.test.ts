import { describe, it, expect } from 'vitest';

import { parseFrontmatter, parseBody, validateName } from './skills.js';

describe('skills', () => {
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
});
