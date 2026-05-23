import { accessSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, normalize, resolve } from 'node:path';
import yargs from 'yargs';

import { log } from './log.js';

export type Context = {
  orgId?: string;
  projectId?: string;
  branchId?: string;
};

const CONTEXT_FILE = '.neon';
const GITIGNORE_FILE = '.gitignore';

const wrapWithContextFile = (dir: string) => resolve(dir, CONTEXT_FILE);

/**
 * Resolve the default `.neon` path for the current working directory.
 *
 * Walks UP from `cwd` looking ONLY for an already-existing `.neon` file so
 * commands run from a sub-directory of a linked project still pick up the
 * project's context. If no `.neon` is found, the path defaults to
 * `<cwd>/.neon`, which makes `neonctl link` and `neonctl set-context`
 * predictable: they always write the context file into the directory they
 * were invoked from.
 *
 * Historically the walk also considered `package.json` and `.git` as project
 * markers, but that led to surprising behaviour when running `link` from a
 * fresh sub-directory inside an unrelated repo (the new link would land in
 * the parent repo's root instead of the cwd).
 *
 * `cwd` is overridable so tests can exercise the walk-up without mutating
 * `process.cwd()` (which would race with other tests running in parallel).
 */
export const currentContextFile = (cwd: string = process.cwd()) => {
  let currentDir = cwd;
  const root = normalize('/');
  const home = homedir();
  while (currentDir !== root && currentDir !== home) {
    try {
      accessSync(resolve(currentDir, CONTEXT_FILE));
      return wrapWithContextFile(currentDir);
    } catch {
      // ignore
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
  if (args._[0] === 'set-context' || args._[0] === 'link') {
    return;
  }
  const context = readContextFile(args.contextFile);
  if (!args.orgId) {
    args.orgId = context.orgId;
  }
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

/**
 * Shared primitive used by `set-context` and `link` to persist context.
 * Mirrors the destructive write semantics of `updateContextFile` —
 * any field not present in `context` is dropped from the file.
 *
 * After writing, ensures a `.gitignore` file sits alongside `.neon` and lists
 * it, so the linked context doesn't accidentally end up in source control.
 */
export const applyContext = (file: string, context: Context) => {
  updateContextFile(file, context);
  ensureGitignored(file);
};

/**
 * Make sure the `.gitignore` next to `file` lists the file's basename
 * (currently always `.neon`). Creates the `.gitignore` if it doesn't exist,
 * or appends `.neon` if it's missing — never duplicates an existing entry.
 *
 * Best-effort: a failure here (e.g. read-only filesystem) is logged at debug
 * level and swallowed; persisting the context file is the primary goal and
 * must not be blocked by a `.gitignore` write error.
 */
export const ensureGitignored = (file: string): void => {
  try {
    const dir = dirname(file);
    const entry = basenameOf(file);
    const gitignorePath = resolve(dir, GITIGNORE_FILE);

    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, `${entry}\n`);
      return;
    }

    const current = readFileSync(gitignorePath, 'utf-8');
    if (hasGitignoreEntry(current, entry)) {
      return;
    }

    const needsLeadingNewline = current.length > 0 && !current.endsWith('\n');
    const addition = `${needsLeadingNewline ? '\n' : ''}${entry}\n`;
    writeFileSync(gitignorePath, current + addition);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug('Failed to update .gitignore next to %s: %s', file, message);
  }
};

const basenameOf = (file: string): string => {
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1] || CONTEXT_FILE;
};

const hasGitignoreEntry = (content: string, entry: string): boolean => {
  return content.split(/\r?\n/).some((line) => line.trim() === entry);
};
