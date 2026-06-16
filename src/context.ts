import { accessSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, normalize, resolve } from 'node:path';
import yargs from 'yargs';

import { log } from './log.js';

/**
 * Git → Neon mapping persisted in `.neon` so `git checkout` can drive `neonctl checkout`.
 * The keys are git branch names; the **values are real Neon branch names** (valid slugs, the
 * same form stored in {@link Context.branch}). The map is built up as branches are resolved,
 * so a git branch always resolves to the same Neon branch on subsequent checkouts.
 */
export type GitContextConfig = {
  /** When true, the installed git `post-checkout` hook drives `neonctl git sync`. */
  follow?: boolean;
  /** git branch name -> Neon branch name (a valid Neon slug). */
  map?: Record<string, string>;
};

export type Context = {
  orgId?: string;
  projectId?: string;
  /**
   * The pinned branch, stored as its **name** when known (nicer to read in
   * `.neon`) or its id otherwise. Resolved to an id by the usual name-or-id
   * resolution wherever a branch id is needed.
   */
  branch?: string;
  /**
   * Legacy field. Still read via {@link contextBranch} so older `.neon` files
   * keep working, but new writes use {@link Context.branch}; the legacy field is
   * dropped the next time the context is written.
   */
  branchId?: string;
  /**
   * Git → Neon workflow state (the branch mapping and `follow` flag). Preserved across
   * writes by {@link applyContext} unless a caller explicitly provides a new `git` block,
   * so project/org/branch updates (e.g. the deprecated `set-context`, or a plain `checkout`)
   * never wipe the mapping.
   */
  git?: GitContextConfig;
};

/**
 * The branch pinned in a context, reading the current `branch` field and
 * falling back to the legacy `branchId` so pre-migration `.neon` files keep
 * working.
 */
export const contextBranch = (context: Context): string | undefined =>
  context.branch ?? context.branchId;

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
  // `link` and the deprecated `set-context` manage the context file themselves
  // and must see the raw flags rather than values pre-filled from an existing
  // `.neon`, so skip enrichment for both.
  if (args._[0] === 'link' || args._[0] === 'set-context') {
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
    args.branch = contextBranch(context);
  }
};

export const updateContextFile = (file: string, context: Context) => {
  writeFileSync(file, JSON.stringify(context, null, 2));
};

/**
 * Shared primitive used by `link`, the deprecated `set-context`, and `checkout`
 * to persist context. The project/org/branch trio keeps its destructive write
 * semantics — any of those not present in `context` is dropped from the file, so
 * existing scripts behave unchanged — but the {@link Context.git} block is
 * **preserved** when the caller doesn't provide one. That makes a plain
 * `set-context` / `checkout` non-destructive to the git → Neon mapping: you can
 * re-pin project/org/branch without wiping the branch map a user (or
 * `neonctl git sync`) built up. Pass an explicit `git` to replace it.
 *
 * `.gitignore` scaffolding only happens when the context file is being
 * *created* (it didn't exist before this write). On updates to an existing
 * `.neon` we never touch `.gitignore`, so a user who deliberately un-ignored
 * the file (e.g. to commit shared context) won't have the entry re-added on
 * every subsequent command.
 */
export const applyContext = (file: string, context: Context) => {
  const isNewFile = !existsSync(file);
  // Preserve the git mapping unless the caller explicitly replaces it. This is what makes
  // `set-context` / `checkout` non-destructive to the git → Neon workflow state.
  const existing = isNewFile ? {} : readContextFile(file);
  const merged: Context =
    context.git === undefined && existing.git !== undefined
      ? { ...context, git: existing.git }
      : context;
  updateContextFile(file, merged);
  if (isNewFile) {
    ensureGitignored(file);
  }
};

/** Look up the Neon branch a git branch maps to in the persisted `.neon` context. */
export const gitBranchMapping = (
  context: Context,
  gitBranch: string,
): string | undefined => context.git?.map?.[gitBranch];

/**
 * Record a git branch -> Neon branch mapping in `.neon`, merging into any existing map and
 * preserving the rest of the context. Passes an explicit `git` so {@link applyContext}
 * replaces (rather than just preserves) the block with the new entry folded in.
 */
export const setGitBranchMapping = (
  file: string,
  gitBranch: string,
  neonBranch: string,
): void => {
  const context = readContextFile(file);
  const git: GitContextConfig = {
    ...context.git,
    map: { ...context.git?.map, [gitBranch]: neonBranch },
  };
  applyContext(file, { ...context, git });
};

/** Set the `git.follow` flag (whether the post-checkout hook drives `neonctl git sync`). */
export const setGitFollow = (file: string, follow: boolean): void => {
  const context = readContextFile(file);
  applyContext(file, {
    ...context,
    git: { ...context.git, follow },
  });
};

/**
 * A fully-resolved project context: the org and project are always known, the
 * branch optionally so (pin one later with `neonctl checkout`).
 */
export type ResolvedContext = {
  orgId: string;
  projectId: string;
  /** Branch name (preferred) or id. Optional. */
  branch?: string;
};

/**
 * Low-level writer for callers that already hold the resolved identifiers and
 * just need to record them — e.g. `init` or `projects create`, which create a
 * project and want to link it without the resolution, verification, prompting,
 * or env-pull that `link` performs.
 *
 * Unlike the loose {@link applyContext}, this enforces at the type level that
 * `orgId` and `projectId` are present, so the `.neon` file never ends up with a
 * dangling project that has no org. The branch stays optional. It writes through
 * {@link applyContext}, so the same `.gitignore` scaffolding applies.
 */
export const setContext = (file: string, context: ResolvedContext) => {
  applyContext(file, {
    orgId: context.orgId,
    projectId: context.projectId,
    branch: context.branch,
  });
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
