import { describe, expect, test } from 'vitest';

import { createVarStore } from './variables.js';
import {
  applyEnvOverrides,
  defaultSettings,
  DEFAULT_PROMPT1,
  DEFAULT_PROMPT2,
  DEFAULT_PROMPT3,
} from './settings.js';

describe('defaultSettings', () => {
  test('populates psql defaults verbatim from settings.h', () => {
    const v = createVarStore();
    const s = defaultSettings(v);

    expect(s.prompt1).toBe('%/%R%x%# ');
    expect(s.prompt2).toBe('%/%R%x%# ');
    expect(s.prompt3).toBe('>> ');
    expect(s.verbosity).toBe('default');
    expect(s.showContext).toBe('errors');
    expect(s.echo).toBe('none');
    expect(s.echoHidden).toBe('off');
    expect(s.onErrorRollback).toBe('off');
    expect(s.compCase).toBe('preserve-upper');
    expect(s.sendMode).toBe('extended-query');
    expect(s.histControl).toBe('none');
    expect(s.onErrorStop).toBe(false);
    expect(s.quiet).toBe(false);
    expect(s.singleline).toBe(false);
    expect(s.singlestep).toBe(false);
    expect(s.timing).toBe(false);
    expect(s.fetchCount).toBe(0);
    expect(s.hideCompression).toBe(false);
    expect(s.hideTableam).toBe(false);
  });

  test('leaves Connection null at WP-07 time', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    expect(s.db).toBeNull();
  });

  test('initializes popt with aligned/border=1 defaults', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    expect(s.popt.topt.format).toBe('aligned');
    expect(s.popt.topt.border).toBe(1);
    expect(s.popt.topt.expanded).toBe('off');
    expect(s.popt.topt.pager).toBe('off');
    expect(s.popt.topt.startTable).toBe(true);
    expect(s.popt.topt.stopTable).toBe(true);
    expect(s.popt.topt.defaultFooter).toBe(true);
    expect(s.popt.topt.fieldSep).toBe('|');
    expect(s.popt.topt.recordSep).toBe('\n');
    expect(s.popt.topt.csvFieldSep).toBe(',');
  });

  test('seeds PROMPT1/PROMPT2/PROMPT3 vars in the store', () => {
    const v = createVarStore();
    defaultSettings(v);
    expect(v.get('PROMPT1')).toBe(DEFAULT_PROMPT1);
    expect(v.get('PROMPT2')).toBe(DEFAULT_PROMPT2);
    expect(v.get('PROMPT3')).toBe(DEFAULT_PROMPT3);
  });

  test('\\set PROMPT1 … propagates to settings.prompt1', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    v.set('PROMPT1', 'foo> ');
    expect(s.prompt1).toBe('foo> ');
  });

  test('\\set COMP_KEYWORD_CASE … propagates to settings.compCase', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    // Default is preserve-upper.
    expect(s.compCase).toBe('preserve-upper');

    // Each canonical spelling flips the field.
    v.set('COMP_KEYWORD_CASE', 'lower');
    expect(s.compCase).toBe('lower');

    v.set('COMP_KEYWORD_CASE', 'upper');
    expect(s.compCase).toBe('upper');

    v.set('COMP_KEYWORD_CASE', 'preserve-lower');
    expect(s.compCase).toBe('preserve-lower');

    v.set('COMP_KEYWORD_CASE', 'preserve-upper');
    expect(s.compCase).toBe('preserve-upper');

    // Case-insensitive input.
    v.set('COMP_KEYWORD_CASE', 'LOWER');
    expect(s.compCase).toBe('lower');

    // Unset restores the default.
    v.unset('COMP_KEYWORD_CASE');
    expect(s.compCase).toBe('preserve-upper');
  });

  test('seeds LAST_ERROR_* sentinel vars', () => {
    const v = createVarStore();
    defaultSettings(v);
    expect(v.get('LAST_ERROR_MESSAGE')).toBe('');
    expect(v.get('LAST_ERROR_SQLSTATE')).toBe('00000');
  });

  test('seeds SHOW_ALL_RESULTS to "on" by default', () => {
    const v = createVarStore();
    defaultSettings(v);
    expect(v.get('SHOW_ALL_RESULTS')).toBe('on');
    expect(v.asBool('SHOW_ALL_RESULTS', false)).toBe(true);
  });

  test('seeds ENCODING to "UTF8" by default', () => {
    const v = createVarStore();
    defaultSettings(v);
    expect(v.get('ENCODING')).toBe('UTF8');
  });

  test('seeds WATCH_INTERVAL to "2" by default (DEFAULT_WATCH_INTERVAL)', () => {
    // Upstream initializes pset.watch_interval to 2 in startup.c so a
    // bare `\watch` (no `i=`) polls every 2 seconds. Mirror that here so
    // `\echo :WATCH_INTERVAL` and the watch loop both observe the
    // documented default before the user touches it.
    const v = createVarStore();
    defaultSettings(v);
    expect(v.get('WATCH_INTERVAL')).toBe('2');
  });

  test('seeds AUTOCOMMIT to "on" by default', () => {
    const v = createVarStore();
    defaultSettings(v);
    expect(v.get('AUTOCOMMIT')).toBe('on');
  });
});

describe('defaultSettings — special-variable hooks', () => {
  describe('AUTOCOMMIT', () => {
    test('rejects non-boolean with upstream wording', () => {
      const v = createVarStore();
      defaultSettings(v);
      const r = v.trySet('AUTOCOMMIT', 'foo');
      expect(r).toEqual({
        ok: false,
        reason: 'hook-veto',
        error: 'unrecognized value "foo" for "AUTOCOMMIT": Boolean expected',
      });
      // Veto leaves the prior value intact.
      expect(v.get('AUTOCOMMIT')).toBe('on');
    });

    test('accepts boolean spellings', () => {
      const v = createVarStore();
      defaultSettings(v);
      expect(v.set('AUTOCOMMIT', 'off')).toBe(true);
      expect(v.get('AUTOCOMMIT')).toBe('off');
      expect(v.set('AUTOCOMMIT', 'true')).toBe(true);
      expect(v.set('AUTOCOMMIT', 'no')).toBe(true);
    });

    test('empty value substitutes to "on" (bool_substitute_hook parity)', () => {
      const v = createVarStore();
      defaultSettings(v);
      v.set('AUTOCOMMIT', 'off');
      expect(v.set('AUTOCOMMIT', '')).toBe(true);
      expect(v.get('AUTOCOMMIT')).toBe('on');
    });
  });

  describe('FETCH_COUNT', () => {
    test('rejects non-integer with upstream wording', () => {
      const v = createVarStore();
      defaultSettings(v);
      const r = v.trySet('FETCH_COUNT', 'foo');
      expect(r).toEqual({
        ok: false,
        reason: 'hook-veto',
        error: 'invalid value "foo" for "FETCH_COUNT": integer expected',
      });
    });

    test('accepts integer and updates settings.fetchCount', () => {
      const v = createVarStore();
      const s = defaultSettings(v);
      expect(v.set('FETCH_COUNT', '42')).toBe(true);
      expect(s.fetchCount).toBe(42);
    });

    test('empty value is rejected (vanilla psql 18 parity)', () => {
      // Upstream `fetch_count_substitute_hook` only handles NULL; empty
      // `\set FETCH_COUNT` reaches `fetch_count_hook` →
      // `ParseVariableNum("")` which fails with the "integer expected"
      // diagnostic. The prior value is preserved.
      const v = createVarStore();
      const s = defaultSettings(v);
      v.set('FETCH_COUNT', '10');
      expect(s.fetchCount).toBe(10);
      const r = v.trySet('FETCH_COUNT', '');
      expect(r).toEqual({
        ok: false,
        reason: 'hook-veto',
        error: 'invalid value "" for "FETCH_COUNT": integer expected',
      });
      expect(s.fetchCount).toBe(10);
      expect(v.get('FETCH_COUNT')).toBe('10');
    });

    test('unset substitutes to "0" (fetch_count_substitute_hook parity)', () => {
      const v = createVarStore();
      const s = defaultSettings(v);
      v.set('FETCH_COUNT', '42');
      expect(s.fetchCount).toBe(42);
      v.unset('FETCH_COUNT');
      expect(v.get('FETCH_COUNT')).toBe('0');
      expect(s.fetchCount).toBe(0);
    });

    test('seeds FETCH_COUNT to "0" on startup', () => {
      const v = createVarStore();
      defaultSettings(v);
      expect(v.get('FETCH_COUNT')).toBe('0');
    });
  });

  describe('ON_ERROR_ROLLBACK', () => {
    test('rejects unknown value with upstream multi-line wording', () => {
      const v = createVarStore();
      defaultSettings(v);
      const r = v.trySet('ON_ERROR_ROLLBACK', 'foo');
      expect(r).toEqual({
        ok: false,
        reason: 'hook-veto',
        error:
          'unrecognized value "foo" for "ON_ERROR_ROLLBACK"\nAvailable values are: on, off, interactive.',
      });
    });

    test('accepts on/off/interactive', () => {
      const v = createVarStore();
      const s = defaultSettings(v);
      v.set('ON_ERROR_ROLLBACK', 'on');
      expect(s.onErrorRollback).toBe('on');
      v.set('ON_ERROR_ROLLBACK', 'off');
      expect(s.onErrorRollback).toBe('off');
      v.set('ON_ERROR_ROLLBACK', 'interactive');
      expect(s.onErrorRollback).toBe('interactive');
    });

    test('empty value substitutes to "on" (regress/psql line 15-16)', () => {
      const v = createVarStore();
      defaultSettings(v);
      expect(v.set('ON_ERROR_ROLLBACK', '')).toBe(true);
      expect(v.get('ON_ERROR_ROLLBACK')).toBe('on');
    });
  });

  describe('VERBOSITY', () => {
    test('rejects unknown value', () => {
      const v = createVarStore();
      defaultSettings(v);
      const r = v.trySet('VERBOSITY', 'foo');
      expect(r).toEqual({
        ok: false,
        reason: 'hook-veto',
        error:
          'unrecognized value "foo" for "VERBOSITY"\nAvailable values are: default, verbose, terse, sqlstate.',
      });
    });

    test('accepts canonical spellings and reflects on settings.verbosity', () => {
      const v = createVarStore();
      const s = defaultSettings(v);
      v.set('VERBOSITY', 'verbose');
      expect(s.verbosity).toBe('verbose');
      v.set('VERBOSITY', 'TERSE');
      expect(s.verbosity).toBe('terse');
    });
  });

  describe('ECHO', () => {
    test('rejects unknown value', () => {
      const v = createVarStore();
      defaultSettings(v);
      const r = v.trySet('ECHO', 'sometimes');
      expect(typeof r === 'object' && !r.ok && r.reason === 'hook-veto').toBe(
        true,
      );
    });

    test('accepts canonical spellings', () => {
      const v = createVarStore();
      const s = defaultSettings(v);
      v.set('ECHO', 'queries');
      expect(s.echo).toBe('queries');
      v.set('ECHO', 'all');
      expect(s.echo).toBe('all');
    });
  });

  describe('ECHO_HIDDEN', () => {
    test('rejects unknown value with three-element list', () => {
      const v = createVarStore();
      defaultSettings(v);
      const r = v.trySet('ECHO_HIDDEN', 'maybe');
      expect(r).toEqual({
        ok: false,
        reason: 'hook-veto',
        error:
          'unrecognized value "maybe" for "ECHO_HIDDEN"\nAvailable values are: on, off, noexec.',
      });
    });

    test('accepts noexec', () => {
      const v = createVarStore();
      const s = defaultSettings(v);
      v.set('ECHO_HIDDEN', 'noexec');
      expect(s.echoHidden).toBe('noexec');
    });
  });

  describe('SHOW_CONTEXT', () => {
    test('accepts canonical spellings', () => {
      const v = createVarStore();
      const s = defaultSettings(v);
      v.set('SHOW_CONTEXT', 'always');
      expect(s.showContext).toBe('always');
    });
    test('rejects unknown value', () => {
      const v = createVarStore();
      defaultSettings(v);
      const r = v.trySet('SHOW_CONTEXT', 'foo');
      expect(typeof r === 'object' && !r.ok).toBe(true);
    });
  });

  describe('HISTCONTROL', () => {
    test('accepts canonical spellings', () => {
      const v = createVarStore();
      const s = defaultSettings(v);
      v.set('HISTCONTROL', 'ignoredups');
      expect(s.histControl).toBe('ignoredups');
    });
    test('rejects unknown value', () => {
      const v = createVarStore();
      defaultSettings(v);
      const r = v.trySet('HISTCONTROL', 'foo');
      expect(typeof r === 'object' && !r.ok).toBe(true);
    });
  });

  describe('SHOW_ALL_RESULTS', () => {
    test('rejects non-boolean', () => {
      const v = createVarStore();
      defaultSettings(v);
      const r = v.trySet('SHOW_ALL_RESULTS', 'foo');
      expect(r).toEqual({
        ok: false,
        reason: 'hook-veto',
        error:
          'unrecognized value "foo" for "SHOW_ALL_RESULTS": Boolean expected',
      });
    });
  });

  describe('ON_ERROR_STOP', () => {
    test('rejects non-boolean', () => {
      const v = createVarStore();
      defaultSettings(v);
      const r = v.trySet('ON_ERROR_STOP', 'foo');
      expect(r).toEqual({
        ok: false,
        reason: 'hook-veto',
        error: 'unrecognized value "foo" for "ON_ERROR_STOP": Boolean expected',
      });
    });

    test('accepts boolean and reflects on settings.onErrorStop', () => {
      const v = createVarStore();
      const s = defaultSettings(v);
      v.set('ON_ERROR_STOP', 'on');
      expect(s.onErrorStop).toBe(true);
      v.set('ON_ERROR_STOP', 'off');
      expect(s.onErrorStop).toBe(false);
    });

    test('empty value substitutes to "on"', () => {
      const v = createVarStore();
      const s = defaultSettings(v);
      v.set('ON_ERROR_STOP', '');
      expect(v.get('ON_ERROR_STOP')).toBe('on');
      expect(s.onErrorStop).toBe(true);
    });
  });

  describe('QUIET', () => {
    test('seeded "off" on startup via bool_substitute_hook', () => {
      const v = createVarStore();
      const s = defaultSettings(v);
      expect(v.get('QUIET')).toBe('off');
      expect(s.quiet).toBe(false);
    });

    test('accepts boolean and mirrors into settings.quiet', () => {
      const v = createVarStore();
      const s = defaultSettings(v);
      v.set('QUIET', 'on');
      expect(s.quiet).toBe(true);
      v.set('QUIET', 'off');
      expect(s.quiet).toBe(false);
    });

    test('rejects non-boolean with upstream wording', () => {
      const v = createVarStore();
      defaultSettings(v);
      const r = v.trySet('QUIET', 'maybe');
      expect(r).toEqual({
        ok: false,
        reason: 'hook-veto',
        error: 'unrecognized value "maybe" for "QUIET": Boolean expected',
      });
    });
  });

  describe('SINGLELINE', () => {
    test('seeded "off" on startup; reflects on settings.singleline', () => {
      const v = createVarStore();
      const s = defaultSettings(v);
      expect(v.get('SINGLELINE')).toBe('off');
      expect(s.singleline).toBe(false);
      v.set('SINGLELINE', 'on');
      expect(s.singleline).toBe(true);
    });
  });

  describe('SINGLESTEP', () => {
    test('seeded "off" on startup; reflects on settings.singlestep', () => {
      const v = createVarStore();
      const s = defaultSettings(v);
      expect(v.get('SINGLESTEP')).toBe('off');
      expect(s.singlestep).toBe(false);
      v.set('SINGLESTEP', 'on');
      expect(s.singlestep).toBe(true);
    });
  });

  describe('HIDE_TOAST_COMPRESSION', () => {
    test('seeded "off" on startup; reflects on settings.hideCompression', () => {
      const v = createVarStore();
      const s = defaultSettings(v);
      expect(v.get('HIDE_TOAST_COMPRESSION')).toBe('off');
      expect(s.hideCompression).toBe(false);
      v.set('HIDE_TOAST_COMPRESSION', 'on');
      expect(s.hideCompression).toBe(true);
    });
  });

  describe('HIDE_TABLEAM', () => {
    test('seeded "off" on startup; reflects on settings.hideTableam', () => {
      const v = createVarStore();
      const s = defaultSettings(v);
      expect(v.get('HIDE_TABLEAM')).toBe('off');
      expect(s.hideTableam).toBe(false);
      v.set('HIDE_TABLEAM', 'on');
      expect(s.hideTableam).toBe(true);
    });
  });

  describe('HISTSIZE', () => {
    test('seeded "500" on startup (histsize_substitute_hook parity)', () => {
      const v = createVarStore();
      defaultSettings(v);
      expect(v.get('HISTSIZE')).toBe('500');
    });

    test('accepts integer values', () => {
      const v = createVarStore();
      defaultSettings(v);
      expect(v.set('HISTSIZE', '1000')).toBe(true);
      expect(v.get('HISTSIZE')).toBe('1000');
    });

    test('rejects non-integer with "integer expected" wording', () => {
      const v = createVarStore();
      defaultSettings(v);
      const r = v.trySet('HISTSIZE', 'foo');
      expect(r).toEqual({
        ok: false,
        reason: 'hook-veto',
        error: 'invalid value "foo" for "HISTSIZE": integer expected',
      });
    });

    test('empty value rejected; preserves prior value', () => {
      const v = createVarStore();
      defaultSettings(v);
      v.set('HISTSIZE', '750');
      const r = v.trySet('HISTSIZE', '');
      expect(r.ok).toBe(false);
      expect(v.get('HISTSIZE')).toBe('750');
    });

    test('unset substitutes to "500"', () => {
      const v = createVarStore();
      defaultSettings(v);
      v.set('HISTSIZE', '1234');
      v.unset('HISTSIZE');
      expect(v.get('HISTSIZE')).toBe('500');
    });
  });

  describe('WATCH_INTERVAL', () => {
    test('seeded "2" on startup via watch_interval_substitute_hook', () => {
      const v = createVarStore();
      defaultSettings(v);
      expect(v.get('WATCH_INTERVAL')).toBe('2');
    });

    test('accepts non-negative numeric values', () => {
      const v = createVarStore();
      defaultSettings(v);
      expect(v.set('WATCH_INTERVAL', '0')).toBe(true);
      expect(v.set('WATCH_INTERVAL', '1.5')).toBe(true);
      expect(v.set('WATCH_INTERVAL', '999999')).toBe(true);
    });

    test('empty value emits invalid-syntax error', () => {
      const v = createVarStore();
      defaultSettings(v);
      const r = v.trySet('WATCH_INTERVAL', '');
      expect(r).toEqual({
        ok: false,
        reason: 'hook-veto',
        error: 'invalid input syntax for variable "WATCH_INTERVAL"',
      });
    });

    test('junk emits invalid-value error without range suffix', () => {
      const v = createVarStore();
      defaultSettings(v);
      const r = v.trySet('WATCH_INTERVAL', 'on');
      expect(r).toEqual({
        ok: false,
        reason: 'hook-veto',
        error: 'invalid value "on" for variable "WATCH_INTERVAL"',
      });
    });

    test('negative values emit "must be greater than 0.00" suffix', () => {
      const v = createVarStore();
      defaultSettings(v);
      const r = v.trySet('WATCH_INTERVAL', '-1');
      expect(r).toEqual({
        ok: false,
        reason: 'hook-veto',
        error:
          'invalid value "-1" for variable "WATCH_INTERVAL": must be greater than 0.00',
      });
    });

    test('over-max values emit "must be less than 1000000.00" suffix', () => {
      const v = createVarStore();
      defaultSettings(v);
      const r = v.trySet('WATCH_INTERVAL', '2000000');
      expect(r).toEqual({
        ok: false,
        reason: 'hook-veto',
        error:
          'invalid value "2000000" for variable "WATCH_INTERVAL": must be less than 1000000.00',
      });
    });

    test('unset substitutes to "2"', () => {
      const v = createVarStore();
      defaultSettings(v);
      v.set('WATCH_INTERVAL', '7');
      v.unset('WATCH_INTERVAL');
      expect(v.get('WATCH_INTERVAL')).toBe('2');
    });
  });

  describe('\\unset substitute-on-null round-trips (vanilla psql 18 parity)', () => {
    // Each row below: variable name, expected value after `\unset NAME`.
    // Variables matching upstream's `bool_substitute_hook` (null → "off")
    // are the bulk; enum substitute hooks return their canonical defaults.
    // Verified empirically against vanilla psql 18 on 2026-05-27. The
    // pattern is `\unset NAME; \echo :NAME` — vanilla prints the
    // substituted default (not the literal `:NAME` token).
    test.each([
      // bool_substitute_hook variants
      ['ON_ERROR_STOP', 'off'],
      ['QUIET', 'off'],
      ['SINGLELINE', 'off'],
      ['SINGLESTEP', 'off'],
      ['ECHO_HIDDEN', 'off'],
      ['ON_ERROR_ROLLBACK', 'off'],
      ['SHOW_ALL_RESULTS', 'off'],
      ['HIDE_TOAST_COMPRESSION', 'off'],
      ['HIDE_TABLEAM', 'off'],
      // AUTOCOMMIT default = "on", but `\unset AUTOCOMMIT` → "off" via
      // bool_substitute_hook (vanilla parity)
      ['AUTOCOMMIT', 'off'],
      // enum substitute hooks
      ['VERBOSITY', 'default'],
      ['SHOW_CONTEXT', 'errors'],
      ['ECHO', 'none'],
      ['COMP_KEYWORD_CASE', 'preserve-upper'],
      ['HISTCONTROL', 'none'],
      // numeric / per-variable substitute hooks
      ['FETCH_COUNT', '0'],
      ['HISTSIZE', '500'],
      ['WATCH_INTERVAL', '2'],
    ])('\\unset %s substitutes to "%s"', (name, expected) => {
      const v = createVarStore();
      defaultSettings(v);
      // Set to a non-default value first so we know the substitute fires.
      v.set(name, name === 'WATCH_INTERVAL' ? '7' : 'on');
      v.unset(name);
      expect(v.get(name)).toBe(expected);
    });

    // PROMPT1/2/3 and HISTFILE use NULL substitute hooks upstream — `\unset`
    // genuinely clears the slot; `\echo :NAME` prints the literal token.
    test.each([['PROMPT1'], ['PROMPT2'], ['PROMPT3'], ['HISTFILE']])(
      '\\unset %s genuinely clears the slot',
      (name) => {
        const v = createVarStore();
        defaultSettings(v);
        v.set(name, 'value');
        v.unset(name);
        expect(v.has(name)).toBe(false);
      },
    );

    // TIMING has no hook upstream — initial value is literal `:TIMING`,
    // unset clears the slot. We deliberately do not register a hook so
    // `\echo :TIMING` matches vanilla's behavior.
    test('TIMING has no hook (literal :TIMING token initially)', () => {
      const v = createVarStore();
      defaultSettings(v);
      expect(v.has('TIMING')).toBe(false);
      expect(v.get('TIMING')).toBeUndefined();
    });
  });

  describe('startup default values match vanilla psql 18 \\echo output', () => {
    // Mirrors `\echo :NAME` immediately after psql starts. The values come
    // from the substitute hook firing on `SetVariableHooks` registration
    // (upstream) / `addHook` (us). Variables not in this list either:
    //   - have no hook (TIMING, HISTFILE → :NAME literal), or
    //   - have an explicit `SetVariable*Bool` (AUTOCOMMIT, SHOW_ALL_RESULTS
    //     → "on") that overrides the substitute.
    test.each([
      ['VERBOSITY', 'default'],
      ['SHOW_CONTEXT', 'errors'],
      ['ECHO', 'none'],
      ['ECHO_HIDDEN', 'off'],
      ['COMP_KEYWORD_CASE', 'preserve-upper'],
      ['HISTCONTROL', 'none'],
      ['FETCH_COUNT', '0'],
      ['HISTSIZE', '500'],
      ['WATCH_INTERVAL', '2'],
      ['ON_ERROR_STOP', 'off'],
      ['ON_ERROR_ROLLBACK', 'off'],
      ['QUIET', 'off'],
      ['SINGLELINE', 'off'],
      ['SINGLESTEP', 'off'],
      ['HIDE_TOAST_COMPRESSION', 'off'],
      ['HIDE_TABLEAM', 'off'],
      ['AUTOCOMMIT', 'on'],
      ['SHOW_ALL_RESULTS', 'on'],
    ])('%s = %s', (name, expected) => {
      const v = createVarStore();
      defaultSettings(v);
      expect(v.get(name)).toBe(expected);
    });
  });
});

describe('applyEnvOverrides', () => {
  test('PSQL_HISTORY → HISTFILE var', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    applyEnvOverrides(s, { PSQL_HISTORY: '/tmp/h.log' });
    expect(v.get('HISTFILE')).toBe('/tmp/h.log');
  });

  test('PSQL_HISTSIZE and PSQL_HISTCONTROL captured', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    applyEnvOverrides(s, {
      PSQL_HISTSIZE: '5000',
      PSQL_HISTCONTROL: 'ignoredups',
    });
    expect(v.get('HISTSIZE')).toBe('5000');
    expect(v.get('HISTCONTROL')).toBe('ignoredups');
  });

  test('PAGER and PSQL_PAGER → PAGER var (PSQL_PAGER wins)', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    applyEnvOverrides(s, { PAGER: 'less', PSQL_PAGER: 'more' });
    expect(v.get('PAGER')).toBe('more');
  });

  test('plain PAGER captured when PSQL_PAGER missing', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    applyEnvOverrides(s, { PAGER: 'less' });
    expect(v.get('PAGER')).toBe('less');
  });

  test('PSQL_WATCH_PAGER captured', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    applyEnvOverrides(s, { PSQL_WATCH_PAGER: 'less -F' });
    expect(v.get('PSQL_WATCH_PAGER')).toBe('less -F');
  });

  test('EDITOR / VISUAL / PSQL_EDITOR → EDITOR (PSQL_EDITOR wins)', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    applyEnvOverrides(s, {
      EDITOR: 'vi',
      VISUAL: 'nano',
      PSQL_EDITOR: 'emacs',
    });
    expect(v.get('EDITOR')).toBe('emacs');
  });

  test('VISUAL wins over EDITOR when PSQL_EDITOR is unset', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    applyEnvOverrides(s, { EDITOR: 'vi', VISUAL: 'nano' });
    expect(v.get('EDITOR')).toBe('nano');
  });

  test('PSQL_EDITOR_LINENUMBER_ARG → EDITOR_LINENUMBER_ARG var', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    applyEnvOverrides(s, { PSQL_EDITOR_LINENUMBER_ARG: '+%d' });
    expect(v.get('EDITOR_LINENUMBER_ARG')).toBe('+%d');
  });

  test('PSQLRC captured', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    applyEnvOverrides(s, { PSQLRC: '/home/me/.psqlrc' });
    expect(v.get('PSQLRC')).toBe('/home/me/.psqlrc');
  });

  test('NO_COLOR captured when non-empty', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    applyEnvOverrides(s, { NO_COLOR: '1' });
    expect(v.get('NO_COLOR')).toBe('1');
  });

  test('NO_COLOR ignored when empty', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    applyEnvOverrides(s, { NO_COLOR: '' });
    expect(v.has('NO_COLOR')).toBe(false);
  });

  test('COLUMNS maps to popt.topt.envColumns', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    applyEnvOverrides(s, { COLUMNS: '132' });
    expect(s.popt.topt.envColumns).toBe(132);
  });

  test('COLUMNS junk leaves envColumns at default 0', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    applyEnvOverrides(s, { COLUMNS: 'wide' });
    expect(s.popt.topt.envColumns).toBe(0);
  });

  test('empty values are ignored', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    applyEnvOverrides(s, {
      PAGER: '',
      PSQL_HISTORY: '',
      EDITOR: '',
    });
    expect(v.has('PAGER')).toBe(false);
    expect(v.has('HISTFILE')).toBe(false);
    expect(v.has('EDITOR')).toBe(false);
  });

  test('missing env vars do not throw', () => {
    const v = createVarStore();
    const s = defaultSettings(v);
    expect(() => {
      applyEnvOverrides(s, {});
    }).not.toThrow();
    expect(v.has('PAGER')).toBe(false);
  });
});
