/**
 * Public entrypoint for psql tab completion.
 *
 * The `LineEditor` (WP-24) accepts a `Completer` of shape
 * `(input, cursor) => Promise<CompletionResult>`. We return a CURRIED
 * factory `psqlCompleter(ctx)` that captures the settings reference so the
 * completer can read `ctx.settings.db` lazily on every call — important
 * because `\c` swaps out the live connection.
 *
 * `CompletionResult` (defined in lineEditor/complete.ts):
 *
 *   - candidates:    string[]   the list shown / inserted
 *   - commonPrefix:  string     longest prefix the editor can insert without
 *                               making a choice (`apply` walks this)
 *   - replaceLength: number     code-points to chop off the buffer before
 *                               inserting `candidates[i]` / commonPrefix
 *
 * Our `findCompletions` returns raw candidate strings; we compute the common
 * prefix here. `replaceLength` is the code-point length of the partial word
 * the cursor was sitting on (`currentWord`), which we already compute in
 * `splitForCompletion` during tokenization.
 */

import type { Completer, CompletionResult } from '../io/lineEditor/complete.js';
import type { PsqlSettings } from '../types/settings.js';

import { splitForCompletion } from './matcher.js';
import { findCompletions, type CompleteContext } from './rules.js';

export type PsqlCompleterContext = {
  settings: PsqlSettings;
};

/**
 * Build a completer bound to the given settings. The settings reference is
 * captured by closure; we never snapshot, so changes to `settings.db` (via
 * `\c`) take effect immediately.
 */
export const psqlCompleter = (ctx: PsqlCompleterContext): Completer => {
  const completer: Completer = async (
    input: string,
    cursor: number,
  ): Promise<CompletionResult> => {
    const { prevWords, currentWord, replaceLength } = splitForCompletion(
      input,
      cursor,
    );
    const ruleCtx: CompleteContext = { settings: ctx.settings };
    const { candidates } = await findCompletions(
      prevWords,
      currentWord,
      ruleCtx,
    );

    // De-duplicate while preserving order.
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const c of candidates) {
      if (!seen.has(c)) {
        seen.add(c);
        deduped.push(c);
      }
    }
    // Stable sort so the listing is predictable. The first-character sort
    // key uses lowercase so case-mixed candidate lists don't look chaotic.
    deduped.sort((a, b) => {
      const la = a.toLowerCase();
      const lb = b.toLowerCase();
      if (la < lb) return -1;
      if (la > lb) return 1;
      return 0;
    });

    const commonPrefix = longestCommonPrefix(deduped, currentWord);

    return {
      candidates: deduped,
      commonPrefix,
      replaceLength,
    };
  };
  return completer;
};

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Return the longest common prefix of all candidates, but never shorter
 * than the user's partial input (so we don't backtrack the buffer when the
 * completion is a no-op).
 *
 * If there's a single candidate, returns it whole.
 */
const longestCommonPrefix = (
  candidates: readonly string[],
  fallback: string,
): string => {
  if (candidates.length === 0) return fallback;
  if (candidates.length === 1) return candidates[0];
  // Use code-point iteration so multi-byte characters don't get cut.
  const arrs = candidates.map((c) => Array.from(c));
  const minLen = arrs.reduce((m, a) => Math.min(m, a.length), Infinity);
  const out: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const first = arrs[0][i];
    let ok = true;
    for (let j = 1; j < arrs.length; j++) {
      if (arrs[j][i] !== first) {
        ok = false;
        break;
      }
    }
    if (!ok) break;
    out.push(first);
  }
  // Common prefix should not be shorter than what's already typed.
  const candidatePrefix = out.join('');
  if (candidatePrefix.length >= fallback.length) return candidatePrefix;
  return fallback;
};
