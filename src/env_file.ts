import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Default dotenv file `env pull` writes to: `.env` when one already exists in the working
 * directory (update where secrets already live), otherwise `.env.local` — matching the
 * `vercel env pull` convention. An explicit `--file` always wins over this.
 */
export const resolveEnvFilePath = (cwd: string, file?: string): string => {
  if (file) return join(cwd, file);
  if (existsSync(join(cwd, '.env'))) return join(cwd, '.env');
  return join(cwd, '.env.local');
};

/**
 * Options for {@link mergeEnvFile} / {@link mergeEnvContent}.
 */
export type MergeEnvOptions = {
  /**
   * Keys the writer *owns*, so any that appear on disk but are absent from `updates` are
   * removed (rather than preserved). Used by `env pull` to prune Neon-managed vars the
   * branch no longer has — e.g. `NEON_AUTH_*` / `NEON_DATA_API_*` left behind after the
   * working directory is pointed at a project/branch without those features. Keys outside
   * this set are always preserved, so a user's own lines are never touched.
   */
  managedKeys?: Iterable<string>;
};

/**
 * Merge `updates` into the dotenv content at `path`, preserving every other line
 * (comments, blank lines, unrelated keys) and the file's existing order. Keys present in
 * both are updated in place; keys only in `updates` are appended. A non-existent file is
 * treated as empty. When `managedKeys` is given, any owned key on disk that is absent from
 * `updates` is removed. Returns the keys written and the (managed) keys removed.
 */
export const mergeEnvFile = (
  path: string,
  updates: Record<string, string>,
  options: MergeEnvOptions = {},
): { written: string[]; removed: string[] } => {
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const { content, written, removed } = mergeEnvContent(
    original,
    updates,
    options,
  );
  writeFileSync(path, content);
  return { written, removed };
};

/**
 * Pure core of {@link mergeEnvFile}: takes the current file content and the updates, and
 * returns the new content plus which keys were written / removed. Kept side-effect-free so
 * it can be unit-tested without touching the filesystem.
 */
export const mergeEnvContent = (
  original: string,
  updates: Record<string, string>,
  options: MergeEnvOptions = {},
): { content: string; written: string[]; removed: string[] } => {
  const keys = Object.keys(updates);

  // Owned keys the current pull did not produce: stale Neon-managed vars to prune. Anything
  // not in `managedKeys` is always kept, so a user's own lines are never removed.
  const stale = new Set(
    [...(options.managedKeys ?? [])].filter((key) => !(key in updates)),
  );

  if (keys.length === 0 && stale.size === 0) {
    return { content: original, written: [], removed: [] };
  }

  const remaining = new Set(keys);
  const removed: string[] = [];
  const lines = original === '' ? [] : original.split('\n');

  // Walk the file: drop stale owned lines, update existing keys in place (so their position
  // and any surrounding comments are preserved), and pass everything else through untouched.
  const updatedLines: string[] = [];
  for (const line of lines) {
    const key = parseKey(line);
    if (key !== null && stale.has(key)) {
      removed.push(key);
      continue;
    }
    if (key !== null && remaining.has(key)) {
      remaining.delete(key);
      updatedLines.push(formatLine(key, updates[key]));
      continue;
    }
    updatedLines.push(line);
  }

  // Append keys that weren't already present, in the order they were given.
  const appended = keys
    .filter((key) => remaining.has(key))
    .map((key) => formatLine(key, updates[key]));

  const body = trimTrailingBlank(updatedLines);
  const content = [...body, ...appended].join('\n');
  return {
    // A dotenv file ends with a trailing newline.
    content: content === '' ? '' : `${content}\n`,
    written: keys,
    removed,
  };
};

/**
 * Read a dotenv file at `path` into a plain `{ KEY: value }` map. A non-existent file is an
 * error (callers pass an explicit `--env` path, so a typo should fail loudly rather than
 * silently load nothing). Quotes are stripped and `\"` / `\\` unescaped, matching the
 * quoting {@link mergeEnvFile} writes. Comments, blank lines, and non-assignment lines are
 * ignored.
 */
export const readEnvFile = (path: string): Record<string, string> => {
  if (!existsSync(path)) {
    throw new Error(`Env file not found: ${path}`);
  }
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const parsed = parseAssignment(line);
    if (parsed) out[parsed.key] = parsed.value;
  }
  return out;
};

/**
 * Load a dotenv file into `process.env` so values are available to anything read later
 * (e.g. a `neon.ts` whose function `env` values come from `process.env.X`). Existing
 * `process.env` entries are **not** overridden — an already-exported var wins over the
 * file, matching dotenv's default. Returns the keys that were applied.
 */
export const loadEnvFileIntoProcess = (path: string): string[] => {
  const parsed = readEnvFile(path);
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
};

/**
 * Extract the variable name from a dotenv line, or `null` for comments / blank lines / any
 * line that isn't a `KEY=value` assignment. Tolerates a leading `export ` and surrounding
 * whitespace, matching common `.env` styles.
 */
const parseKey = (line: string): string | null => {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return match ? match[1] : null;
};

/**
 * Parse a `KEY=value` dotenv line into its key and unquoted value, or `null` for
 * comments / blank lines / non-assignments. Mirrors {@link formatLine}'s quoting.
 */
const parseAssignment = (
  line: string,
): { key: string; value: string } | null => {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
    line,
  );
  const key = match?.[1];
  const raw = match?.[2];
  if (key === undefined || raw === undefined) return null;
  return { key, value: unquote(raw.trim()) };
};

/** Strip matching surrounding quotes and unescape `\"` / `\\` inside double quotes. */
const unquote = (value: string): string => {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
};

/**
 * Render a `KEY=value` line. The value is wrapped in double quotes when it contains
 * characters that would otherwise break parsing (spaces, `#`, quotes, `=`), with inner
 * quotes/backslashes escaped — Neon connection strings and URLs are safe either way, but
 * quoting defensively avoids surprises for tools that re-parse the file.
 */
const formatLine = (key: string, value: string): string => {
  const needsQuotes = /[\s#"'=]/.test(value);
  if (!needsQuotes) return `${key}=${value}`;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${key}="${escaped}"`;
};

/** Drop trailing blank lines so we don't accumulate them across repeated merges. */
const trimTrailingBlank = (lines: string[]): string[] => {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1]?.trim() === '') out.pop();
  return out;
};
