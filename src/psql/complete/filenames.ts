/**
 * Filesystem-driven completion candidates for `\lo_*`, `\copy ... FROM/TO`,
 * and SQL `COPY ... FROM/TO`.
 *
 * Upstream psql implements this via readline's `rl_filename_completion_function`
 * plus a couple of custom `complete_from_files*` wrappers. We don't have
 * readline; we re-implement the bits we need with `fs.readdirSync`.
 *
 * The completer enumerates entries in the directory referenced by the
 * partial input, filters by basename prefix, and returns *full* candidates
 * (path + basename, matching what the user typed). Directories get a
 * trailing `/` so the editor's `shouldAppendSpace` keeps the user typing
 * through them.
 *
 * For the SQL `COPY ... FROM/TO` context — where the filename must be a
 * string literal — the candidates are wrapped in single quotes. Closing
 * quotes are added only when the candidate is a final filename (unique
 * match), so the line editor's "balanced quotes → append space" rule
 * fires; partial multi-candidate prefixes leave the closing quote off so
 * the user can keep typing.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

/**
 * How the result should be quoted when inserted into the buffer.
 *
 *   - `none`  : raw filename, no quotes added. Used by `\lo_import` /
 *               `\lo_export` and `\copy` (psql backslash commands accept
 *               bare paths).
 *   - `sql`   : wrap in single quotes for the SQL `COPY ... FROM/TO`
 *               context where the path must be a string literal.
 */
export type FilenameQuoteContext = 'none' | 'sql';

/**
 * Enumerate filesystem entries matching the partial path the user typed.
 *
 * `currentWord` is the raw token (post-tokenizer). It may contain a leading
 * `'` (when the user is already inside a single-quoted SQL literal). The
 * function strips that, looks up the dirname/basename, and returns full
 * candidates that the line editor can splice in with `replaceLength = code
 * points in currentWord`.
 *
 * Returns an empty array on any filesystem error (e.g. directory doesn't
 * exist, no read permission). Tab completion is best-effort — failing to
 * complete is the same as "no candidates".
 */
export const completeFilenames = (
  currentWord: string,
  quoteCtx: FilenameQuoteContext,
  cwd: string = process.cwd(),
): string[] => {
  // Strip an opening single quote (the SQL string-literal case) before
  // resolving the path. The tokenizer keeps it as part of the word.
  let raw = currentWord;
  let hadOpeningSingleQuote = false;
  if (raw.startsWith("'")) {
    hadOpeningSingleQuote = true;
    raw = raw.slice(1);
  }

  // Split into dir + basename prefix. A trailing `/` means "enumerate this
  // dir" and basename prefix is empty.
  const lastSlash = raw.lastIndexOf('/');
  const dirPart = lastSlash === -1 ? '' : raw.slice(0, lastSlash + 1);
  const basePrefix = lastSlash === -1 ? raw : raw.slice(lastSlash + 1);

  // Resolve the directory to scan. Empty `dirPart` → cwd; otherwise it's
  // taken relative to cwd (or absolute if starts with `/`).
  const scanDir =
    dirPart === ''
      ? cwd
      : dirPart.startsWith('/')
        ? dirPart
        : join(cwd, dirPart);

  let entries: string[];
  try {
    entries = readdirSync(scanDir);
  } catch {
    return [];
  }

  // Filter by prefix. Filesystem matching is case-sensitive on Linux/macOS
  // (case-insensitive on macOS by default, but we mirror upstream readline's
  // behaviour which honours the OS's path semantics — case-sensitive on
  // POSIX, which is what the conformance suite runs on).
  const filtered = entries.filter((e) => e.startsWith(basePrefix));

  // Sort alphabetically so the listing is predictable.
  filtered.sort();

  // Build the candidates. Each is `dirPart + entry` (full path matching
  // what the user typed) plus optional trailing `/` for directories.
  const candidates: string[] = [];
  for (const entry of filtered) {
    let isDir = false;
    try {
      isDir = statSync(join(scanDir, entry)).isDirectory();
    } catch {
      // Broken symlink etc. — treat as regular file.
    }
    const full = dirPart + entry + (isDir ? '/' : '');
    candidates.push(full);
  }

  if (quoteCtx === 'none') {
    // Bare paths. Preserve any opening single quote the user already typed
    // (rare for the no-quote contexts, but harmless to mirror).
    if (hadOpeningSingleQuote) {
      return candidates.map((c) => "'" + c);
    }
    return candidates;
  }

  // SQL string-literal context: wrap candidates in single quotes. The
  // line editor's `shouldAppendSpace` checks quote balance — unique
  // candidates close the quote (so `'...'` balances → trailing space
  // fires), multi-candidate common prefixes leave the closing quote off.
  if (candidates.length === 1 && !candidates[0].endsWith('/')) {
    // Unique file (not directory): close the quote so the trailing space
    // fires. Opening quote: re-add if user typed it, else add ourselves.
    return ["'" + candidates[0] + "'"];
  }
  // Multiple candidates OR directory match: opening quote only; closing
  // quote is deferred so the user keeps typing.
  return candidates.map((c) => "'" + c);
};

/**
 * Helper used by `rules.ts` to decide whether the SQL `COPY` we're
 * completing for is a `FROM` (input file) or `TO` (output file). Returns
 * `true` for either — both want filename completion.
 *
 * `prevWords` here is the full prev-words token list. We look for the
 * pattern `COPY <table>+ [FROM|TO]` anywhere as a tail match.
 */
export const isCopyFromOrTo = (prevWords: readonly string[]): boolean => {
  if (prevWords.length < 3) return false;
  // Walk from the end backward: the immediate prev word must be FROM or TO,
  // and somewhere earlier must be COPY (case-insensitive).
  const last = prevWords[prevWords.length - 1].toUpperCase();
  if (last !== 'FROM' && last !== 'TO') return false;
  for (let i = prevWords.length - 2; i >= 0; i--) {
    if (prevWords[i].toUpperCase() === 'COPY') return true;
    // If we walk past the start of statement (e.g. another keyword like
    // SELECT) we abort — only the SQL `COPY` form should match.
    if (
      prevWords[i].toUpperCase() === 'SELECT' ||
      prevWords[i].toUpperCase() === 'INSERT' ||
      prevWords[i].toUpperCase() === 'UPDATE' ||
      prevWords[i].toUpperCase() === 'DELETE' ||
      prevWords[i].toUpperCase() === 'WITH'
    ) {
      return false;
    }
  }
  return false;
};

// Re-export for tests.
export const _internals = { basename, dirname };
