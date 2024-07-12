import { accessSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { normalize, resolve } from 'node:path';
import yargs from 'yargs';

export type Context = {
  projectId?: string;
  branchId?: string;
};

const CONTEXT_FILE = '.neon';
const CHECK_FILES = [CONTEXT_FILE, 'package.json', '.git'];

const wrapWithContextFile = (dir: string) => resolve(dir, CONTEXT_FILE);

export const currentContextFile = () => {
  const cwd = process.cwd();
  let currentDir = cwd;
  const root = normalize('/');
  const home = homedir();
  while (currentDir !== root && currentDir !== home) {
    for (const file of CHECK_FILES) {
      try {
        accessSync(resolve(currentDir, file));
        return wrapWithContextFile(currentDir);
      } catch {
        // ignore
      }
    }
    currentDir = resolve(currentDir, '..');
  }

  return wrapWithContextFile(cwd);
};

export const readContextFile = (file: string): Context => {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
};

export const enrichFromContext = (
  args: yargs.Arguments<{ contextFile: string }>,
) => {
  if (args._[0] === 'set-context') {
    return;
  }
  const context = readContextFile(args.contextFile);
  if (!args.projectId) {
    args.projectId = context.projectId;
  }
  if (
    !args.branch &&
    !args.id &&
    !args.name &&
    context.projectId === args.projectId
  ) {
    args.branch = context.branchId;
  }
};

export const updateContextFile = (file: string, context: Context) => {
  writeFileSync(file, JSON.stringify(context, null, 2));
};
