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
 * Merge `updates` into the dotenv content at `path`, preserving every other line
 * (comments, blank lines, unrelated keys) and the file's existing order. Keys present in
 * both are updated in place; keys only in `updates` are appended. A non-existent file is
 * treated as empty. Returns the list of keys that were written (for reporting).
 */
export const mergeEnvFile = (
  path: string,
  updates: Record<string, string>,
): { written: string[] } => {
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const { content, written } = mergeEnvContent(original, updates);
  writeFileSync(path, content);
  return { written };
};

/**
 * Pure core of {@link mergeEnvFile}: takes the current file content and the updates, and
 * returns the new content plus which keys were written. Kept side-effect-free so it can be
 * unit-tested without touching the filesystem.
 */
export const mergeEnvContent = (
  original: string,
  updates: Record<string, string>,
): { content: string; written: string[] } => {
  const keys = Object.keys(updates);
  if (keys.length === 0) return { content: original, written: [] };

  const remaining = new Set(keys);
  const lines = original === '' ? [] : original.split('\n');

  // Update keys in place where they already appear, so their position and any surrounding
  // comments are preserved.
  const updatedLines = lines.map((line) => {
    const key = parseKey(line);
    if (key !== null && remaining.has(key)) {
      remaining.delete(key);
      return formatLine(key, updates[key]);
    }
    return line;
  });

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
  };
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
