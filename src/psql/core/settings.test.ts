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
