import { accessSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { normalize, resolve } from 'node:path';
import yargs from 'yargs';

export type Context = {
  orgId?: string;
  projectId?: string;
  branchId?: string;
};

const CONTEXT_FILE = '.neon';

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
 */
export const applyContext = (file: string, context: Context) => {
  updateContextFile(file, context);
};
