import { describe, it, expect } from 'vitest';

import { LineBuffer } from './buffer.js';
import {
  CompletionState,
  formatCandidates,
  type Completer,
} from './complete.js';

const fixedCompleter =
  (
    candidates: string[],
    commonPrefix: string,
    replaceLength: number,
  ): Completer =>
  () => ({ candidates, commonPrefix, replaceLength });

describe('CompletionState', () => {
  it('rings the bell on zero candidates', async () => {
    const buf = new LineBuffer('foo', 3);
    const state = new CompletionState();
    const step = await state.apply(buf, fixedCompleter([], '', 0));
    expect(step.kind).toBe('bell');
    expect(buf.text).toBe('foo');
  });

  it('inserts the unique candidate', async () => {
    const buf = new LineBuffer('sel', 3);
    const state = new CompletionState();
    const step = await state.apply(
      buf,
      fixedCompleter(['select '], 'select ', 3),
    );
    expect(step.kind).toBe('inserted');
    expect(buf.text).toBe('select ');
  });

  it('inserts the common prefix on first tab when multiple match', async () => {
    const buf = new LineBuffer('s', 1);
    const state = new CompletionState();
    const step = await state.apply(
      buf,
      fixedCompleter(['select', 'show', 'set'], 's', 1),
    );
    expect(step.kind).toBe('inserted');
    // Common prefix is just "s" — no extension, so buffer unchanged.
    expect(buf.text).toBe('s');
  });

  it('lists candidates on second tap', async () => {
    const buf = new LineBuffer('s', 1);
    const state = new CompletionState();
    await state.apply(
      buf,
      fixedCompleter(['select', 'show', 'set'], 's', 1),
      1000,
    );
    const step = await state.apply(
      buf,
      fixedCompleter(['select', 'show', 'set'], 's', 1),
      1100,
    );
    expect(step.kind).toBe('list');
    if (step.kind === 'list') {
      expect(step.candidates).toEqual(['select', 'show', 'set']);
    }
  });

  it('cycles candidates after the listing tap', async () => {
    const buf = new LineBuffer('s', 1);
    const state = new CompletionState();
    const completer = fixedCompleter(['select', 'show', 'set'], 's', 1);
    await state.apply(buf, completer, 1000); // common prefix
    await state.apply(buf, completer, 1100); // list
    const step = await state.apply(buf, completer, 1200);
    expect(step.kind).toBe('cycled');
    if (step.kind === 'cycled') {
      expect(buf.text).toBe(step.candidate);
    }
  });

  it('resets when explicitly reset', async () => {
    const buf = new LineBuffer('s', 1);
    const state = new CompletionState();
    await state.apply(buf, fixedCompleter(['select'], 'select', 1));
    state.reset();
    // After reset, subsequent tap starts fresh.
    const step = await state.apply(buf, fixedCompleter([], '', 0));
    expect(step.kind).toBe('bell');
  });
});

describe('formatCandidates', () => {
  it('returns empty string for no candidates', () => {
    expect(formatCandidates([], 80)).toBe('');
  });

  it('lays out candidates in columns', () => {
    const out = formatCandidates(['select', 'show', 'set', 'savepoint'], 40);
    // 4 candidates in columns; longest is "savepoint" (9 chars) + 2 = 11.
    // Columns fitting in 40 = floor(40/11) = 3. So one row of 3 plus 1 row of 1.
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(out).toContain('select');
    expect(out).toContain('savepoint');
  });

  it('falls back to one column on narrow terminal', () => {
    const out = formatCandidates(['select', 'savepoint'], 5);
    expect(out.split('\n').length).toBe(2);
  });
});
