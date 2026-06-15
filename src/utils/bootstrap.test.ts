import { gunzipSync, gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  FALLBACK_TEMPLATES,
  parseManifest,
  parseTar,
  selectTemplateFiles,
} from './bootstrap.js';

// ---------------------------------------------------------------------------
// Minimal tar builder, used to exercise parseTar with real archive bytes (the
// same layout codeload.github.com produces: a single top-level dir, a leading
// pax global header, directory entries, files, and symlinks).
// ---------------------------------------------------------------------------

type TarInput =
  | { name: string; type: 'file'; mode: number; content: string }
  | { name: string; type: 'dir' }
  | { name: string; type: 'symlink'; target: string }
  | { name: string; type: 'pax-global'; content: string };

const TYPEFLAG = {
  file: '0',
  dir: '5',
  symlink: '2',
  'pax-global': 'g',
} as const;

const tarHeader = (
  name: string,
  size: number,
  mode: number,
  typeflag: string,
  linkname = '',
): Buffer => {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 'utf8');
  header.write(`${(mode & 0o7777).toString(8).padStart(7, '0')}\0`, 100);
  header.write('0000000\0', 108); // uid
  header.write('0000000\0', 116); // gid
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136); // mtime
  header.write('        ', 148); // checksum placeholder (8 spaces)
  header.write(typeflag, 156, 1);
  header.write(linkname, 157, 'utf8');
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += header[i];
  }
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
};

const padTo512 = (buf: Buffer): Buffer => {
  const rem = buf.length % 512;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(512 - rem)]);
};

const buildTar = (inputs: TarInput[]): Buffer => {
  const blocks: Buffer[] = [];
  for (const input of inputs) {
    if (input.type === 'file' || input.type === 'pax-global') {
      const content = Buffer.from(input.content);
      const mode = input.type === 'file' ? input.mode : 0o644;
      blocks.push(
        tarHeader(input.name, content.length, mode, TYPEFLAG[input.type]),
      );
      blocks.push(padTo512(content));
    } else if (input.type === 'symlink') {
      blocks.push(
        tarHeader(input.name, 0, 0o777, TYPEFLAG.symlink, input.target),
      );
    } else {
      blocks.push(tarHeader(input.name, 0, 0o755, TYPEFLAG.dir));
    }
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks terminate the archive
  return Buffer.concat(blocks);
};

// A tarball shaped like codeload's: top-level "examples-main/" dir, a pax
// global header up front, and a sibling example that must be filtered out.
const EXAMPLE_TAR: TarInput[] = [
  {
    name: 'pax_global_header',
    type: 'pax-global',
    content: '52 comment=0000\n',
  },
  { name: 'examples-main/', type: 'dir' },
  { name: 'examples-main/with-hono/', type: 'dir' },
  {
    name: 'examples-main/with-hono/package.json',
    type: 'file',
    mode: 0o644,
    content: '{\n  "name": "with-hono"\n}\n',
  },
  { name: 'examples-main/with-hono/src/', type: 'dir' },
  {
    name: 'examples-main/with-hono/src/index.ts',
    type: 'file',
    mode: 0o644,
    content: 'export const app = "hono";\n',
  },
  {
    name: 'examples-main/with-hono/scripts/run.sh',
    type: 'file',
    mode: 0o755,
    content: '#!/bin/sh\necho hi\n',
  },
  {
    name: 'examples-main/with-hono/.claude/skills/neon',
    type: 'symlink',
    target: '../../package.json',
  },
  {
    name: 'examples-main/with-remix/package.json',
    type: 'file',
    mode: 0o644,
    content: '{ "name": "with-remix" }\n',
  },
];

describe('parseTar + selectTemplateFiles', () => {
  const entries = parseTar(buildTar(EXAMPLE_TAR));

  it('skips the pax global header but keeps directory entries for the caller to filter', () => {
    // The pax global header is consumed by the parser and never surfaces; the
    // directory entries do (selectTemplateFiles is what drops them).
    const names = entries.map((e) => e.name);
    expect(names).not.toContain('pax_global_header');
    expect(entries.some((e) => e.type === '5')).toBe(true);
    // ...and none of those directories leak into the selected files.
    const files = selectTemplateFiles(entries, 'with-hono');
    expect(files.every((f) => f.path !== '' && !f.path.endsWith('/'))).toBe(
      true,
    );
  });

  it('keeps only files under the subdir, prefix stripped', () => {
    const files = selectTemplateFiles(entries, 'with-hono');
    expect(files.map((f) => f.path).sort()).toEqual([
      '.claude/skills/neon',
      'package.json',
      'scripts/run.sh',
      'src/index.ts',
    ]);
  });

  it('preserves contents, exec bits, and symlink targets', () => {
    const byPath = Object.fromEntries(
      selectTemplateFiles(entries, 'with-hono').map((f) => [f.path, f]),
    );

    const pkg = byPath['package.json'];
    expect(pkg.kind).toBe('file');
    if (pkg.kind === 'file') {
      expect(pkg.bytes.toString('utf8')).toBe('{\n  "name": "with-hono"\n}\n');
      expect(pkg.executable).toBe(false);
    }

    const script = byPath['scripts/run.sh'];
    expect(script.kind === 'file' && script.executable).toBe(true);

    const link = byPath['.claude/skills/neon'];
    expect(link.kind).toBe('symlink');
    if (link.kind === 'symlink') {
      expect(link.target).toBe('../../package.json');
    }
  });

  it('does not leak a sibling example from the same repo', () => {
    const files = selectTemplateFiles(entries, 'with-hono');
    expect(files.some((f) => f.path.includes('with-remix'))).toBe(false);
  });

  it('tolerates a trailing or leading slash on the subdir', () => {
    expect(selectTemplateFiles(entries, 'with-hono/')).toHaveLength(4);
    expect(selectTemplateFiles(entries, '/with-hono')).toHaveLength(4);
  });

  it('returns nothing for a subdir that does not exist', () => {
    expect(selectTemplateFiles(entries, 'nope')).toEqual([]);
  });

  it('round-trips through gzip the way the downloader decompresses it', () => {
    // Mirrors downloadTemplate: gzip on the wire, fflate gunzip, then parse.
    const gz = gzipSync(new Uint8Array(buildTar(EXAMPLE_TAR)));
    const files = selectTemplateFiles(
      parseTar(Buffer.from(gunzipSync(gz))),
      'with-hono',
    );
    expect(files).toHaveLength(4);
  });
});

// A single pax "<len> key=value\n" record. The length prefix counts itself, so
// it's solved by fixed-point iteration — the same shape GNU/BSD tar emit.
const paxRecord = (key: string, value: string): string => {
  const record = `${key}=${value}`;
  let len = record.length + 1;
  for (let i = 0; i < 5; i++) {
    len = `${len} ${record}\n`.length;
  }
  return `${len} ${record}\n`;
};

// A pax extended header (typeflag 'x') applying to the next entry, followed by
// that entry (built with the normal file/symlink builder, which also writes the
// archive's terminating zero blocks).
const buildPaxOverride = (records: string, next: TarInput): Buffer => {
  const body = Buffer.from(records);
  return Buffer.concat([
    tarHeader('pax_header', body.length, 0o644, 'x'),
    padTo512(body),
    buildTar([next]),
  ]);
};

describe('parseTar long paths', () => {
  it('honors pax extended headers that override a long path', () => {
    const longPath = `examples-main/with-hono/${'a'.repeat(120)}/deep.txt`;
    const tar = buildPaxOverride(paxRecord('path', longPath), {
      name: 'examples-main/with-hono/short.txt',
      type: 'file',
      mode: 0o644,
      content: 'deep\n',
    });

    const match = parseTar(tar).find((e) => e.name === longPath);
    expect(match?.data.toString('utf8')).toBe('deep\n');
  });

  it('honors pax extended headers that override a long symlink target', () => {
    const longTarget = `../../${'b'.repeat(130)}/target`;
    const tar = buildPaxOverride(paxRecord('linkpath', longTarget), {
      name: 'examples-main/with-hono/link',
      type: 'symlink',
      target: 'placeholder',
    });

    const files = selectTemplateFiles(parseTar(tar), 'with-hono');
    const link = files.find((f) => f.path === 'link');
    expect(link?.kind).toBe('symlink');
    if (link?.kind === 'symlink') {
      expect(link.target).toBe(longTarget);
    }
  });
});

describe('parseManifest', () => {
  it('parses a valid manifest', () => {
    const yaml = `templates:
  - id: hono
    title: Hono API
    description: A Hono template.
    source:
      owner: neondatabase
      repo: examples
      ref: main
      subdir: with-hono
`;
    const templates = parseManifest(yaml);
    expect(templates).toHaveLength(1);
    expect(templates[0]).toEqual({
      id: 'hono',
      title: 'Hono API',
      description: 'A Hono template.',
      source: {
        owner: 'neondatabase',
        repo: 'examples',
        ref: 'main',
        subdir: 'with-hono',
      },
    });
  });

  it('parses the optional services list', () => {
    const yaml = `templates:
  - id: hono
    title: Hono API
    description: A Hono template.
    services:
      - Postgres
      - Functions
    source:
      owner: neondatabase
      repo: examples
      ref: main
      subdir: with-hono
`;
    expect(parseManifest(yaml)[0].services).toEqual(['Postgres', 'Functions']);
  });

  it('drops non-string and blank service entries', () => {
    const yaml = `templates:
  - id: hono
    title: Hono API
    description: A Hono template.
    services:
      - Postgres
      - ""
      - 42
      - Functions
    source:
      owner: neondatabase
      repo: examples
      ref: main
      subdir: with-hono
`;
    expect(parseManifest(yaml)[0].services).toEqual(['Postgres', 'Functions']);
  });

  it('omits services when the field is absent or not a list', () => {
    const withoutServices = `templates:
  - id: hono
    title: Hono API
    description: A Hono template.
    source:
      owner: neondatabase
      repo: examples
      ref: main
      subdir: with-hono
`;
    expect(parseManifest(withoutServices)[0]).not.toHaveProperty('services');

    const badServices = `templates:
  - id: hono
    title: Hono API
    description: A Hono template.
    services: nope
    source:
      owner: neondatabase
      repo: examples
      ref: main
      subdir: with-hono
`;
    expect(parseManifest(badServices)[0]).not.toHaveProperty('services');
  });

  it('skips malformed entries and keeps valid ones', () => {
    const yaml = `templates:
  - id: good
    title: Good
    description: A good template.
    source:
      owner: org
      repo: repo
      ref: main
      subdir: good
  - id: bad-no-source
    title: Bad
    description: Missing source field.
  - not-even-an-object
`;
    const templates = parseManifest(yaml);
    expect(templates).toHaveLength(1);
    expect(templates[0].id).toBe('good');
  });

  it('returns an empty array when all entries are malformed', () => {
    const yaml = `templates:
  - id: 123
    title: numeric id
`;
    expect(parseManifest(yaml)).toEqual([]);
  });

  it('throws when the top-level structure is invalid', () => {
    expect(() => parseManifest('not-yaml: []')).toThrow(
      'missing "templates" array',
    );
    expect(() => parseManifest('templates: not-an-array')).toThrow(
      'missing "templates" array',
    );
  });

  it('handles an empty templates array', () => {
    expect(parseManifest('templates: []')).toEqual([]);
  });
});

describe('FALLBACK_TEMPLATES', () => {
  it('offers the full starter set, not just one template', () => {
    expect(FALLBACK_TEMPLATES.map((t) => t.id)).toEqual([
      'hono',
      'ai-sdk',
      'mastra',
    ]);
  });
});
