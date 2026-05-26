/**
 * psql Settings.
 *
 * TypeScript port of the `pset` initialization performed by PostgreSQL's
 * `src/bin/psql/startup.c` and the defaults declared in `src/bin/psql/settings.h`.
 *
 * Two responsibilities:
 *
 *  1. `defaultSettings(varStore)` — build a fully-initialized `PsqlSettings`
 *     with the same defaults psql itself uses (prompts, verbosity, send mode,
 *     completion case, print options, etc.). The Connection (`settings.db`)
 *     stays `null` here; it is populated later by the startup/connect WP.
 *
 *  2. `applyEnvOverrides(settings, env?)` — bridge process environment to psql
 *     state. Some variables psql looks up "live" (e.g. PSQL_HISTORY when
 *     readline is initialized in `src/bin/psql/input.c`, PSQL_EDITOR/EDITOR/
 *     VISUAL when `\e` is invoked in `command.c`, PAGER/PSQL_PAGER from
 *     `fe_utils/print.c`). We capture them eagerly into the var store under
 *     stable names so later WPs can read them without re-reading
 *     `process.env`. The COLUMNS env var maps to `popt.topt.envColumns` to
 *     mirror upstream's `pset.popt.topt.env_columns` assignment.
 *
 * Deviations from upstream:
 *
 *  - psql exposes `notty` based on isatty(stdin) && isatty(stdout). We have
 *    no stream context at construction time, so the default is `false`;
 *    higher-level WPs (startup) override this.
 *  - The PROMPT1/PROMPT2/PROMPT3 psql variables and `settings.prompt{1,2,3}`
 *    are seeded to the same defaults and kept in sync via `addHook` so
 *    `\set PROMPT1 …` reflects in `settings.prompt1`. Upstream achieves this
 *    with `prompt1_hook` etc. in `startup.c`.
 *  - We do not eagerly read PSQLRC (the rc loader lives in a later WP).
 *    Instead we surface PSQLRC verbatim under the `PSQLRC` psql variable.
 */

import type { VarStore } from '../types/variables.js';
import type {
  PsqlSettings,
  CompCase,
  EchoMode,
  EchoHidden,
  HistControl,
  OnErrorRollback,
  SendMode,
  ShowContext,
  VerbosityLevel,
} from '../types/settings.js';
import type { PrintQueryOpts } from '../types/printer.js';

export const DEFAULT_PROMPT1 = '%/%R%x%# ';
export const DEFAULT_PROMPT2 = '%/%R%x%# ';
export const DEFAULT_PROMPT3 = '>> ';
export const DEFAULT_CSV_FIELD_SEP = ',';
export const DEFAULT_FIELD_SEP = '|';
export const DEFAULT_RECORD_SEP = '\n';

const DEFAULT_VERBOSITY: VerbosityLevel = 'default';
const DEFAULT_SHOW_CONTEXT: ShowContext = 'errors';
const DEFAULT_ECHO: EchoMode = 'none';
const DEFAULT_ECHO_HIDDEN: EchoHidden = 'off';
const DEFAULT_ON_ERROR_ROLLBACK: OnErrorRollback = 'off';
const DEFAULT_COMP_CASE: CompCase = 'preserve-upper';
const DEFAULT_SEND_MODE: SendMode = 'extended-query';
const DEFAULT_HIST_CONTROL: HistControl = 'none';

/**
 * Build the psql `PrintQueryOpts` with the same defaults as upstream's
 * pset.popt initialization (see `startup.c` after the `pset.db = NULL`
 * block). border=1, format=aligned, pager=off (we treat pager-on as a
 * separate concern handled by the printer WP), start/stop_table=true,
 * default_footer=true.
 */
const buildDefaultPrintOpts = (): PrintQueryOpts => ({
  topt: {
    format: 'aligned',
    expanded: 'off',
    border: 1,
    pager: 'off',
    pagerMinLines: 0,
    tuplesOnly: false,
    startTable: true,
    stopTable: true,
    defaultFooter: true,
    prior: 0,
    encoding: 'UTF8',
    envColumns: 0,
    columns: 0,
    unicodeBorderLineStyle: 'ascii',
    unicodeColumnLineStyle: 'ascii',
    unicodeHeaderLineStyle: 'ascii',
    fieldSep: DEFAULT_FIELD_SEP,
    recordSep: DEFAULT_RECORD_SEP,
    numericLocale: false,
    tableAttr: null,
    title: null,
    footers: null,
    translateHeader: false,
    translateColumns: null,
    nullPrint: '',
    csvFieldSep: DEFAULT_CSV_FIELD_SEP,
  },
  nullPrint: '',
  title: null,
  footers: null,
  translateHeader: false,
  translateColumns: null,
  nTranslateColumns: 0,
});

/**
 * Build a fresh `PsqlSettings` with psql defaults, backed by the provided
 * variable store. The store is mutated to:
 *
 *  - seed `PROMPT1`/`PROMPT2`/`PROMPT3` to their default strings, and
 *  - wire substitute-style hooks so that subsequent `\set PROMPT1 …` calls
 *    update the corresponding `settings.prompt{1,2,3}` field.
 *
 * Connection (`settings.db`) is left `null`; it is the responsibility of
 * the startup/connect WP to populate it after a successful libpq-equivalent
 * connection.
 */
export const defaultSettings = (varStore: VarStore): PsqlSettings => {
  const settings: PsqlSettings = {
    db: null,
    vars: varStore,
    popt: buildDefaultPrintOpts(),

    mainfile: null,
    inputfile: null,
    curCmdSource: 'stdin',

    prompt1: DEFAULT_PROMPT1,
    prompt2: DEFAULT_PROMPT2,
    prompt3: DEFAULT_PROMPT3,

    notty: false,
    quiet: false,
    singleline: false,
    singlestep: false,
    onErrorStop: false,
    fetchCount: 0,
    verbosity: DEFAULT_VERBOSITY,
    showContext: DEFAULT_SHOW_CONTEXT,
    echo: DEFAULT_ECHO,
    echoHidden: DEFAULT_ECHO_HIDDEN,
    onErrorRollback: DEFAULT_ON_ERROR_ROLLBACK,
    compCase: DEFAULT_COMP_CASE,
    sendMode: DEFAULT_SEND_MODE,
    histControl: DEFAULT_HIST_CONTROL,
    hideCompression: false,
    hideTableam: false,

    logfile: null,
    timing: false,
    lastErrorResult: null,
  };

  // Seed the PROMPT psql variables and wire them to the settings fields so
  // `\set PROMPT1 …` is reflected in `settings.prompt1`. Upstream does this
  // via assign hooks (prompt1_hook / prompt2_hook / prompt3_hook).
  varStore.addHook('PROMPT1', (newValue) => {
    settings.prompt1 = newValue ?? '';
    return true;
  });
  varStore.addHook('PROMPT2', (newValue) => {
    settings.prompt2 = newValue ?? '';
    return true;
  });
  varStore.addHook('PROMPT3', (newValue) => {
    settings.prompt3 = newValue ?? '';
    return true;
  });
  varStore.set('PROMPT1', DEFAULT_PROMPT1);
  varStore.set('PROMPT2', DEFAULT_PROMPT2);
  varStore.set('PROMPT3', DEFAULT_PROMPT3);

  // Mirror upstream's small set of always-present session vars.
  varStore.set('LAST_ERROR_MESSAGE', '');
  varStore.set('LAST_ERROR_SQLSTATE', '00000');

  // SHOW_ALL_RESULTS defaults to 'on' — when off ('0' / 'off') the REPL only
  // prints the final result set of a multi-statement `\;`-separated batch
  // (upstream `pset.show_all_results`, set in startup.c).
  varStore.set('SHOW_ALL_RESULTS', 'on');

  // ENCODING tracks the server's client_encoding ParameterStatus. We seed
  // with the connection-default UTF8 here; mainloop refreshes it after the
  // connection is bound (and again whenever `SET client_encoding` flips the
  // server value). Mirrors `pset.encoding` / `SetVariable("ENCODING", ...)`
  // in upstream startup.c / common.c.
  varStore.set('ENCODING', 'UTF8');

  // WATCH_INTERVAL validation hook. Upstream `assign_watch_interval_hook`
  // (in `startup.c`) rejects non-numeric, negative, or out-of-range values
  // with a "WATCH_INTERVAL ... is out of range" diagnostic. The hook
  // returns `false` to veto the set; the surrounding `\set` plumbing
  // reports the failure.
  varStore.addHook('WATCH_INTERVAL', (newValue) => {
    if (newValue === null) return true; // unset is always allowed
    const ok = isValidWatchInterval(newValue);
    if (!ok) {
      process.stderr.write(
        `\\set: WATCH_INTERVAL "${newValue}" is out of range\n`,
      );
      return false;
    }
    return true;
  });
  // Upstream seeds WATCH_INTERVAL to "2" (DEFAULT_WATCH_INTERVAL, see
  // settings.h) during pset initialization so `\echo :WATCH_INTERVAL`
  // and `\watch` (without an explicit interval) both observe the
  // documented default. After `\unset WATCH_INTERVAL`, upstream
  // re-substitutes the same default via its substitute hook; we accept
  // the simpler "set on init" model — `\unset` removes the value, but
  // `\watch` itself falls back to DEFAULT_WATCH_INTERVAL when the
  // variable is unset (see `resolveWatchIntervalDefault` in cmd_io.ts).
  varStore.set('WATCH_INTERVAL', '2');

  // ON_ERROR_STOP assign hook. Upstream `assign_var_on_error_stop_hook` in
  // startup.c keeps `pset.on_error_stop` in lockstep with the variable so
  // both `--on-error-stop` (which flips the flag directly) and
  // `--set ON_ERROR_STOP=1` (which only writes the variable) take effect.
  // Accepts the same value set as `ParseVariableBool`: on/off, true/false,
  // yes/no, 1/0, or empty (treated as on, matching upstream).
  varStore.addHook('ON_ERROR_STOP', (newValue) => {
    if (newValue === null) {
      settings.onErrorStop = false;
      return true;
    }
    const parsed = parseOnOffBool(newValue);
    settings.onErrorStop = parsed ?? false;
    return true;
  });

  // COMP_KEYWORD_CASE assign hook. Upstream `assign_var_comp_keyword_case_hook`
  // (in startup.c) reflects the spelling into `pset.comp_case`; the completer
  // then consults that on every Tab to decide whether to upper/lower/preserve
  // candidate casing. Accepts the four canonical spellings; anything else is
  // silently ignored, matching upstream's "unsupported value" diagnostic
  // behaviour (we omit the warning for brevity).
  varStore.addHook('COMP_KEYWORD_CASE', (newValue) => {
    if (newValue === null) {
      settings.compCase = DEFAULT_COMP_CASE;
      return true;
    }
    const parsed = parseCompCase(newValue);
    if (parsed === null) return false;
    settings.compCase = parsed;
    return true;
  });

  return settings;
};

/**
 * Parse the COMP_KEYWORD_CASE spelling. Mirrors upstream's recognised values:
 * `lower`, `upper`, `preserve-lower`, `preserve-upper`. Case-insensitive on
 * the input — psql treats `LOWER` and `lower` as equivalent.
 */
const parseCompCase = (raw: string): CompCase | null => {
  switch (raw.toLowerCase().trim()) {
    case 'lower':
      return 'lower';
    case 'upper':
      return 'upper';
    case 'preserve-lower':
      return 'preserve-lower';
    case 'preserve-upper':
      return 'preserve-upper';
    default:
      return null;
  }
};

/**
 * Parse the `on`/`off`/`true`/`false`/`yes`/`no`/`1`/`0` boolean spelling
 * upstream uses for psql variables. Mirrors `ParseVariableBool` (without the
 * error reporting — callers handle that). Returns null on unrecognised input.
 */
const parseOnOffBool = (raw: string): boolean | null => {
  const v = raw.toLowerCase().trim();
  if (v === '' || v === 'on' || v === 'true' || v === 'yes' || v === '1') {
    return true;
  }
  if (v === 'off' || v === 'false' || v === 'no' || v === '0') {
    return false;
  }
  return null;
};

/**
 * Strict validation for `WATCH_INTERVAL`. Mirrors the `\watch` parser:
 * non-negative finite float, capped at a sensible upper bound to catch
 * `1e500` (Infinity) and similar overflows.
 */
const WATCH_INTERVAL_MAX_SECONDS = 100 * 3600;
const isValidWatchInterval = (raw: string): boolean => {
  if (raw.length === 0) return false;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return false;
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) return false;
  if (value < 0) return false;
  if (value > WATCH_INTERVAL_MAX_SECONDS) return false;
  return true;
};

/**
 * Bridge environment variables to psql state. Read-only with respect to the
 * environment; mutates `settings` (and its var store) in place.
 *
 * The variable names below match upstream where it reads them lazily:
 *
 *  - PAGER, PSQL_PAGER, PSQL_WATCH_PAGER — consulted by `fe_utils/print.c`
 *    (`PageOutput`) and `\watch`. Captured as psql vars so later WPs read
 *    a single source of truth.
 *  - EDITOR, VISUAL, PSQL_EDITOR, PSQL_EDITOR_LINENUMBER_ARG — consulted
 *    by `\e`/`\ef`/`\ev` in `command.c::editFile`.
 *  - PSQL_HISTORY — `src/bin/psql/input.c::initializeInput` uses it as the
 *    history file path when readline is active. Stored as HISTFILE for
 *    parity with psql's own `\set HISTFILE` convention.
 *  - PSQL_HISTSIZE / PSQL_HISTCONTROL — likewise from `input.c`, stored
 *    under the corresponding psql var names HISTSIZE / HISTCONTROL.
 *  - PSQLRC — origin of the rc-file path (`startup.c::process_psqlrc`).
 *  - COLUMNS — terminal width hint (`startup.c`: `pset.popt.topt.env_columns`).
 *  - NO_COLOR — `https://no-color.org/` convention; consulted by the
 *    printer/color code in upstream `fe_utils/print.c`. Captured here so
 *    later WPs can opt out of ANSI coloring without re-reading `process.env`.
 */
export const applyEnvOverrides = (
  settings: PsqlSettings,
  env: NodeJS.ProcessEnv = process.env,
): void => {
  const bridge = (envName: string, varName: string): void => {
    const value = env[envName];
    if (value !== undefined && value !== '') {
      settings.vars.set(varName, value);
    }
  };

  // Pager group: PSQL_PAGER takes precedence over PAGER in psql, so set
  // PAGER first and let PSQL_PAGER overwrite it.
  bridge('PAGER', 'PAGER');
  bridge('PSQL_PAGER', 'PAGER');
  bridge('PSQL_WATCH_PAGER', 'PSQL_WATCH_PAGER');

  // Editor group: PSQL_EDITOR > VISUAL > EDITOR in psql. Set in
  // lowest-to-highest precedence so the final wins.
  bridge('EDITOR', 'EDITOR');
  bridge('VISUAL', 'EDITOR');
  bridge('PSQL_EDITOR', 'EDITOR');
  bridge('PSQL_EDITOR_LINENUMBER_ARG', 'EDITOR_LINENUMBER_ARG');

  // History group.
  bridge('PSQL_HISTORY', 'HISTFILE');
  bridge('PSQL_HISTSIZE', 'HISTSIZE');
  bridge('PSQL_HISTCONTROL', 'HISTCONTROL');

  // RC file path.
  bridge('PSQLRC', 'PSQLRC');

  // NO_COLOR — captured under a psql-style var name. The convention is
  // "any non-empty value disables color". We store the raw value so the
  // printer can decide via VarStore.asBool / its own check.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') {
    settings.vars.set('NO_COLOR', env.NO_COLOR);
  }

  // COLUMNS — feed into popt.topt.envColumns (upstream:
  // pset.popt.topt.env_columns = getenv("COLUMNS") ? atoi(...) : 0).
  const cols = env.COLUMNS;
  if (cols !== undefined && cols !== '') {
    const parsed = parseInt(cols, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      settings.popt.topt.envColumns = parsed;
    }
  }
};
