import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import yargs from 'yargs';

import { writer } from '../writer.js';
import { log } from '../log.js';

const SKILLS_REPO = 'neondatabase/agent-skills';
const SKILLS_PATH = 'skills';
const GITHUB_API = `https://api.github.com/repos/${SKILLS_REPO}/contents/${SKILLS_PATH}`;
const GITHUB_RAW = `https://raw.githubusercontent.com/${SKILLS_REPO}/main/${SKILLS_PATH}`;

type SkillMeta = {
  name: string;
  description: string;
  compatibility?: string;
  license?: string;
  installed?: string;
};

type OutputProps = {
  output: 'json' | 'yaml' | 'table';
};

const LIST_FIELDS = [
  'name',
  'description',
  'compatibility',
  'installed',
] as const;

const GET_FIELDS = [
  'name',
  'description',
  'compatibility',
  'license',
  'installed',
] as const;

const GET_FIELDS_FULL = [
  'name',
  'description',
  'compatibility',
  'license',
  'installed',
  'body',
] as const;

const VALID_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export function validateName(name: string): string {
  if (!VALID_NAME.test(name) || name.includes('..')) {
    throw new Error(
      `Invalid skill name "${name}". Names must be lowercase alphanumeric with hyphens, dots, or underscores.`,
    );
  }
  return name;
}

function safePath(baseDir: string, name: string): string {
  const target = resolve(join(baseDir, name));
  const base = resolve(baseDir);
  if (!target.startsWith(base + sep)) {
    throw new Error(`Path traversal detected in "${name}"`);
  }
  return target;
}

export function parseFrontmatter(content: string): SkillMeta {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---/.exec(normalized);
  if (!match) {
    return {
      name: '',
      description: '',
      compatibility: undefined,
      license: undefined,
    };
  }

  const frontmatter = match[1];
  const meta: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line
      .slice(colonIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    meta[key] = value;
  }

  return {
    name: meta.name ?? '',
    description: meta.description ?? '',
    compatibility: meta.compatibility,
    license: meta.license,
  };
}

export function parseBody(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(normalized);
  return match ? match[1].trim() : content;
}

export function getInstallStatus(skillName: string): string {
  try {
    const localBase = join(process.cwd(), '.agents', 'skills');
    const globalBase = join(homedir(), '.agents', 'skills');
    const locations: string[] = [];
    if (existsSync(safePath(localBase, skillName))) locations.push('local');
    if (existsSync(safePath(globalBase, skillName))) locations.push('global');
    return locations.join(', ') || '';
  } catch {
    return '';
  }
}

async function fetchSkillDirs(): Promise<string[]> {
  const response = await fetch(GITHUB_API, {
    headers: { Accept: 'application/vnd.github.v3+json' },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch skills: ${response.statusText}`);
  }
  const items = (await response.json()) as { name: string; type: string }[];
  return items.filter((item) => item.type === 'dir').map((item) => item.name);
}

async function fetchSkillMd(skillName: string): Promise<string> {
  const url = `${GITHUB_RAW}/${skillName}/SKILL.md`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Skill "${skillName}" not found`);
  }
  return response.text();
}

async function fetchDirContents(
  dirPath: string,
): Promise<{ name: string; type: string; download_url: string | null }[]> {
  const url = `https://api.github.com/repos/${SKILLS_REPO}/contents/${dirPath}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github.v3+json' },
  });
  if (!response.ok) return [];
  return response.json() as Promise<
    { name: string; type: string; download_url: string | null }[]
  >;
}

async function downloadDir(remotePath: string, localPath: string) {
  const items = await fetchDirContents(remotePath);
  mkdirSync(localPath, { recursive: true });

  for (const item of items) {
    const localItemPath = safePath(localPath, item.name);
    if (item.type === 'dir') {
      await downloadDir(`${remotePath}/${item.name}`, localItemPath);
    } else if (item.type === 'file' && item.download_url) {
      const res = await fetch(item.download_url);
      if (res.ok) {
        writeFileSync(localItemPath, await res.text(), 'utf-8');
      }
    }
  }
}

// --- Subcommand handlers ---

const list = async (props: OutputProps & { search?: string }) => {
  const dirs = await fetchSkillDirs();
  let skills: SkillMeta[] = await Promise.all(
    dirs.map(async (name) => {
      try {
        const content = await fetchSkillMd(name);
        const meta = parseFrontmatter(content);
        meta.installed = getInstallStatus(name) || undefined;
        return meta;
      } catch {
        return {
          name,
          description: '(unable to fetch)',
          compatibility: undefined,
          license: undefined,
          installed: getInstallStatus(name) || undefined,
        };
      }
    }),
  );

  if (props.search) {
    const term = props.search.toLowerCase();
    skills = skills.filter(
      (s) =>
        s.name.toLowerCase().includes(term) ||
        s.description.toLowerCase().includes(term),
    );
  }

  writer(props).end(skills, {
    fields: LIST_FIELDS,
    title: 'Available Skills',
    emptyMessage: props.search
      ? `No skills matching "${props.search}"`
      : 'No skills found',
  });
};

const get = async (props: OutputProps & { name: string }) => {
  validateName(props.name);
  const content = await fetchSkillMd(props.name);
  const meta = parseFrontmatter(content);
  const body = parseBody(content);
  const installed = getInstallStatus(props.name);

  const skillData = { ...meta, installed: installed || undefined };

  if (props.output === 'json' || props.output === 'yaml') {
    writer(props).end({ ...skillData, body }, { fields: GET_FIELDS_FULL });
  } else {
    const w = writer(props);
    w.write(skillData, {
      fields: GET_FIELDS,
      title: meta.name || props.name,
    });
    w.end();
    process.stdout.write('\n' + body + '\n');
  }
};

const install = async (
  props: OutputProps & { name: string; global: boolean },
) => {
  validateName(props.name);
  // Verify skill exists
  await fetchSkillMd(props.name);

  const baseDir = props.global
    ? join(homedir(), '.agents', 'skills')
    : join(process.cwd(), '.agents', 'skills');

  const targetDir = safePath(baseDir, props.name);

  if (existsSync(targetDir)) {
    log.info(`Skill "${props.name}" is already installed at ${targetDir}`);
    log.info('Updating...');
  }

  const remotePath = `${SKILLS_PATH}/${props.name}`;
  await downloadDir(remotePath, targetDir);

  log.info(`Installed "${props.name}" to ${targetDir}`);
};

// --- Command definition ---

export const command = 'skills';
export const describe = 'Discover and install Neon agent skills';
export const aliases = ['skill'];
export const builder = (argv: yargs.Argv) =>
  argv
    .usage('$0 skills <sub-command> [options]')
    .command(
      'list',
      'List available Neon agent skills',
      (yargs) =>
        yargs.option('search', {
          alias: 's',
          describe: 'Filter skills by name or description',
          type: 'string',
        }),
      (args) => list(args as any),
    )
    .command(
      'get <name>',
      'Fetch a skill and output its contents',
      (yargs) =>
        yargs.positional('name', {
          describe: 'Skill name',
          type: 'string',
          demandOption: true,
        }),
      (args) => get(args as any),
    )
    .command(
      'install <name>',
      'Install a skill into your project or home directory',
      (yargs) =>
        yargs
          .positional('name', {
            describe: 'Skill name',
            type: 'string',
            demandOption: true,
          })
          .option('global', {
            alias: 'g',
            describe: 'Install to ~/.agents/skills/ instead of project-local',
            type: 'boolean',
            default: false,
          }),
      (args) => install(args as any),
    );

export const handler = (args: yargs.Argv) => {
  return args;
};
