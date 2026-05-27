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

import type { VarHookResult, VarStore } from '../types/variables.js';
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

/** Upstream `DEFAULT_WATCH_INTERVAL` from settings.h (psql 18). */
const DEFAULT_WATCH_INTERVAL = '2';
/** Upstream `DEFAULT_WATCH_INTERVAL_MAX` (1e6 seconds). */
const WATCH_INTERVAL_MAX = 1000000;

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
    lastQuery: '',
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

  // WATCH_INTERVAL — upstream `watch_interval_substitute_hook` (null →
  // DEFAULT_WATCH_INTERVAL "2") + `watch_interval_hook` which calls
  // `ParseVariableDouble("WATCH_INTERVAL", ..., 0, DEFAULT_WATCH_INTERVAL_MAX)`.
  // Empty value reaches ParseVariableDouble which short-circuits with
  // "invalid input syntax for variable \"WATCH_INTERVAL\"" without
  // substituting; the previous value is preserved by `trySet`.
  varStore.addHook('WATCH_INTERVAL', (newValue) => {
    if (newValue === null) {
      // `\unset WATCH_INTERVAL` re-seeds the default. The substitute also
      // runs once on `addHook` registration so `\echo :WATCH_INTERVAL`
      // prints "2" before the user touches it (no explicit seed needed).
      return { substitute: DEFAULT_WATCH_INTERVAL };
    }
    if (newValue === '') {
      return `invalid input syntax for variable "WATCH_INTERVAL"`;
    }
    const range = validateWatchInterval(newValue);
    if (range !== null) return range;
    return true;
  });

  // ON_ERROR_STOP assign hook. Upstream `bool_substitute_hook` /
  // `on_error_stop_assign_hook` (startup.c) keep `pset.on_error_stop` in
  // lockstep with the variable so both `--on-error-stop` (which flips the
  // flag directly) and `--set ON_ERROR_STOP=1` (which only writes the
  // variable) take effect. Empty value → "on" (substitute), non-boolean →
  // reject with upstream's wording.
  varStore.addHook(
    'ON_ERROR_STOP',
    makeBoolHook('ON_ERROR_STOP', (parsed) => {
      settings.onErrorStop = parsed;
    }),
  );

  // AUTOCOMMIT assign hook — upstream `bool_substitute_hook` +
  // `autocommit_assign_hook`. Empty value → "on", non-boolean → reject
  // with `unrecognized value "<value>" for "AUTOCOMMIT": Boolean expected`.
  varStore.addHook('AUTOCOMMIT', makeBoolHook('AUTOCOMMIT'));
  // Seed AUTOCOMMIT to "on" (upstream default; pset.autocommit = true).
  varStore.set('AUTOCOMMIT', 'on');

  // FETCH_COUNT — upstream `fetch_count_substitute_hook` (null → "0") +
  // `fetch_count_assign_hook` which delegates to `ParseVariableNum`. Empty
  // `\set FETCH_COUNT` reaches ParseVariableNum which fails with
  // `invalid value "" for "FETCH_COUNT": integer expected`, preserving
  // the prior value. The substitute fires on addHook registration so
  // `\echo :FETCH_COUNT` prints "0" before the user touches it.
  varStore.addHook('FETCH_COUNT', (newValue) => {
    if (newValue === null) {
      settings.fetchCount = 0;
      return { substitute: '0' };
    }
    const n = parseIntOrNull(newValue);
    if (n === null) {
      return `invalid value "${newValue}" for "FETCH_COUNT": integer expected`;
    }
    settings.fetchCount = Math.max(0, n);
    return true;
  });

  // ON_ERROR_ROLLBACK assign hook — upstream `on_error_rollback_substitute_hook`
  // (null → "off", empty → "on") + `on_error_rollback_assign_hook`. Tri-state:
  // on, off, interactive. Non-matching values get the multi-line diagnostic
  // `unrecognized value "<value>" for "ON_ERROR_ROLLBACK"\nAvailable values
  // are: on, off, interactive.`. The substitute on addHook seeds "off" so
  // `\echo :ON_ERROR_ROLLBACK` works without explicit init.
  varStore.addHook(
    'ON_ERROR_ROLLBACK',
    makeOnErrorRollbackHook((parsed) => {
      settings.onErrorRollback = parsed;
    }),
  );

  // VERBOSITY — upstream `verbosity_substitute_hook` (empty → "default")
  // + `verbosity_assign_hook`. Accepts default | verbose | terse | sqlstate.
  varStore.addHook(
    'VERBOSITY',
    makeEnumHook<VerbosityLevel>(
      'VERBOSITY',
      ['default', 'verbose', 'terse', 'sqlstate'],
      'default',
      (parsed) => {
        settings.verbosity = parsed;
      },
    ),
  );

  // SHOW_CONTEXT — upstream `show_context_substitute_hook` (empty → "errors")
  // + `show_context_assign_hook`. Accepts never | errors | always.
  varStore.addHook(
    'SHOW_CONTEXT',
    makeEnumHook<ShowContext>(
      'SHOW_CONTEXT',
      ['never', 'errors', 'always'],
      'errors',
      (parsed) => {
        settings.showContext = parsed;
      },
    ),
  );

  // ECHO — upstream `echo_substitute_hook` (empty → "none") +
  // `echo_assign_hook`. Accepts none | errors | queries | all.
  varStore.addHook(
    'ECHO',
    makeEnumHook<EchoMode>(
      'ECHO',
      ['none', 'errors', 'queries', 'all'],
      'none',
      (parsed) => {
        settings.echo = parsed;
      },
    ),
  );

  // ECHO_HIDDEN — upstream `bool_substitute_hook` +
  // `echo_hidden_assign_hook`. Tri-state: on / off / noexec. Empty → "on".
  varStore.addHook(
    'ECHO_HIDDEN',
    makeEchoHiddenHook((parsed) => {
      settings.echoHidden = parsed;
    }),
  );

  // COMP_KEYWORD_CASE assign hook. Upstream `assign_var_comp_keyword_case_hook`
  // (in startup.c) reflects the spelling into `pset.comp_case`; the completer
  // then consults that on every Tab to decide whether to upper/lower/preserve
  // candidate casing. Accepts the four canonical spellings; the upstream
  // diagnostic wording is `unrecognized value "<value>" for
  // "COMP_KEYWORD_CASE"\nAvailable values are: lower, upper, preserve-lower,
  // preserve-upper.`.
  varStore.addHook(
    'COMP_KEYWORD_CASE',
    makeEnumHook<CompCase>(
      'COMP_KEYWORD_CASE',
      ['lower', 'upper', 'preserve-lower', 'preserve-upper'],
      DEFAULT_COMP_CASE,
      (parsed) => {
        settings.compCase = parsed;
      },
    ),
  );

  // HISTCONTROL — upstream `histcontrol_substitute_hook` (empty → "none") +
  // `histcontrol_assign_hook`. Accepts ignorespace | ignoredups | ignoreboth
  // | none.
  varStore.addHook(
    'HISTCONTROL',
    makeEnumHook<HistControl>(
      'HISTCONTROL',
      ['none', 'ignorespace', 'ignoredups', 'ignoreboth'],
      'none',
      (parsed) => {
        settings.histControl = parsed;
      },
    ),
  );

  // SHOW_ALL_RESULTS — upstream `bool_substitute_hook` +
  // `show_all_results_assign_hook`. Strict boolean; empty → "on".
  varStore.addHook('SHOW_ALL_RESULTS', makeBoolHook('SHOW_ALL_RESULTS'));

  // QUIET — upstream `bool_substitute_hook` + `quiet_hook`. Mirrors into
  // `pset.quiet`. Default ("off") matches the unset substitute, so addHook
  // registration seeds it via the substitute.
  varStore.addHook(
    'QUIET',
    makeBoolHook('QUIET', (parsed) => {
      settings.quiet = parsed;
    }),
  );

  // SINGLELINE — upstream `bool_substitute_hook` + `singleline_hook`.
  // Mirrors into `pset.singleline`.
  varStore.addHook(
    'SINGLELINE',
    makeBoolHook('SINGLELINE', (parsed) => {
      settings.singleline = parsed;
    }),
  );

  // SINGLESTEP — upstream `bool_substitute_hook` + `singlestep_hook`.
  // Mirrors into `pset.singlestep`.
  varStore.addHook(
    'SINGLESTEP',
    makeBoolHook('SINGLESTEP', (parsed) => {
      settings.singlestep = parsed;
    }),
  );

  // HIDE_TOAST_COMPRESSION — upstream `bool_substitute_hook` +
  // `hide_compression_hook`. Mirrors into `pset.hide_compression` (our
  // `settings.hideCompression`). Note: the upstream variable name is
  // HIDE_TOAST_COMPRESSION, not HIDE_COMPRESSION.
  varStore.addHook(
    'HIDE_TOAST_COMPRESSION',
    makeBoolHook('HIDE_TOAST_COMPRESSION', (parsed) => {
      settings.hideCompression = parsed;
    }),
  );

  // HIDE_TABLEAM — upstream `bool_substitute_hook` + `hide_tableam_hook`.
  // Mirrors into `pset.hide_tableam` (our `settings.hideTableam`).
  varStore.addHook(
    'HIDE_TABLEAM',
    makeBoolHook('HIDE_TABLEAM', (parsed) => {
      settings.hideTableam = parsed;
    }),
  );

  // HISTSIZE — upstream `histsize_substitute_hook` (null → "500") +
  // `histsize_hook` which calls `ParseVariableNum`. Empty `\set HISTSIZE`
  // reaches ParseVariableNum and fails with the "integer expected" message,
  // preserving the prior value. We don't drive a derived settings field
  // (readline isn't implemented), but we still install the hook so the
  // variable surface matches vanilla: `\echo :HISTSIZE` prints "500" on
  // startup, accepts integer values, rejects junk.
  varStore.addHook('HISTSIZE', (newValue) => {
    if (newValue === null) {
      return { substitute: '500' };
    }
    const n = parseIntOrNull(newValue);
    if (n === null) {
      return `invalid value "${newValue}" for "HISTSIZE": integer expected`;
    }
    return true;
  });

  return settings;
};

/**
 * Build a strict-boolean hook with upstream's `bool_substitute_hook` +
 * `bool_assign_hook` semantics:
 *
 *   - empty / null → substitute "on"
 *   - on/off/true/false/yes/no/1/0 (case-insensitive) → accepted
 *   - anything else → reject with `unrecognized value "<value>" for
 *     "<name>": Boolean expected`
 *
 * The optional `apply` callback receives the parsed boolean so callers can
 * keep a derived `PsqlSettings` field in sync (e.g. `settings.onErrorStop`).
 */
const makeBoolHook = (
  name: string,
  apply?: (parsed: boolean) => void,
): ((newValue: string | null) => VarHookResult) => {
  return (newValue) => {
    if (newValue === null) {
      // Upstream `bool_substitute_hook`: on `\unset NAME`, re-store "off"
      // so `\echo :NAME` shows the boolean default instead of the literal
      // `:NAME` token. Verified empirically against vanilla psql 18:
      // `\unset AUTOCOMMIT; \echo :AUTOCOMMIT` prints "off".
      apply?.(false);
      return { substitute: 'off' };
    }
    if (newValue === '') {
      // `\set NAME` (empty value) substitutes "on". Verified empirically:
      // `\set AUTOCOMMIT; \echo :AUTOCOMMIT` prints "on".
      apply?.(true);
      return { substitute: 'on' };
    }
    const parsed = parseOnOffBool(newValue);
    if (parsed === null) {
      return `unrecognized value "${newValue}" for "${name}": Boolean expected`;
    }
    apply?.(parsed);
    return true;
  };
};

/**
 * Build an enum-style hook with upstream's substitute / assign pair (the
 * VERBOSITY / SHOW_CONTEXT / ECHO / COMP_KEYWORD_CASE / HISTCONTROL pattern):
 *
 *   - null → substitute the supplied `defaultValue` (matches
 *     `verbosity_substitute_hook` etc. — `\unset NAME` re-stores the default)
 *   - exact-match (case-insensitive) against `allowed` → accepted
 *   - empty / unrecognized → reject with `unrecognized value "<value>" for
 *     "<name>"\nAvailable values are: a, b, c.` (the substitute hooks only
 *     handle NULL upstream — empty falls through to the assign hook's
 *     PsqlVarEnumError path, preserving the prior value)
 *
 * `apply` is invoked with the canonical lowercase spelling whenever the
 * variable is set (including the default-on-null path).
 */
const makeEnumHook = <T extends string>(
  name: string,
  allowed: readonly T[],
  defaultValue: T,
  apply?: (parsed: T) => void,
): ((newValue: string | null) => VarHookResult) => {
  const list = allowed.join(', ');
  return (newValue) => {
    if (newValue === null) {
      apply?.(defaultValue);
      return { substitute: defaultValue };
    }
    const lower = newValue.toLowerCase();
    const match = allowed.find((a) => a.toLowerCase() === lower);
    if (match === undefined) {
      return `unrecognized value "${newValue}" for "${name}"\nAvailable values are: ${list}.`;
    }
    apply?.(match);
    return true;
  };
};

/**
 * `ON_ERROR_ROLLBACK` is upstream's only tri-state boolean — `on` / `off` /
 * `interactive`. Empty / null → substitute "on" (matches
 * `on_error_rollback_substitute_hook`). Other values get the multi-line
 * diagnostic upstream emits from `on_error_rollback_assign_hook`.
 */
const makeOnErrorRollbackHook = (
  apply: (parsed: OnErrorRollback) => void,
): ((newValue: string | null) => VarHookResult) => {
  return (newValue) => {
    if (newValue === null) {
      // Upstream `on_error_rollback_substitute_hook`:
      //   if (newval == NULL) newval = pg_strdup("off");
      // — `\unset ON_ERROR_ROLLBACK` re-stores "off" so a follow-on
      // `\echo :ON_ERROR_ROLLBACK` shows the default rather than the
      // literal `:NAME` token.
      apply('off');
      return { substitute: 'off' };
    }
    if (newValue === '') {
      apply('on');
      return { substitute: 'on' };
    }
    const lower = newValue.toLowerCase();
    if (lower === 'on' || lower === 'off' || lower === 'interactive') {
      apply(lower);
      return true;
    }
    return `unrecognized value "${newValue}" for "ON_ERROR_ROLLBACK"\nAvailable values are: on, off, interactive.`;
  };
};

/**
 * ECHO_HIDDEN tri-state: `on` / `off` / `noexec`. Upstream uses
 * `bool_substitute_hook` (null → "off", empty → "on") plus
 * `echo_hidden_hook` which accepts `noexec` or falls back to
 * `ParseVariableBool`. Anything else gets the upstream "unrecognized
 * value" line with the three-element list.
 */
const makeEchoHiddenHook = (
  apply: (parsed: EchoHidden) => void,
): ((newValue: string | null) => VarHookResult) => {
  return (newValue) => {
    if (newValue === null) {
      // Match `bool_substitute_hook(NULL)` → "off". On addHook registration
      // this seeds `\echo :ECHO_HIDDEN` → "off" (parity with vanilla).
      apply('off');
      return { substitute: 'off' };
    }
    if (newValue === '') {
      apply('on');
      return { substitute: 'on' };
    }
    const lower = newValue.toLowerCase();
    if (lower === 'noexec') {
      apply('noexec');
      return true;
    }
    const parsed = parseOnOffBool(newValue);
    if (parsed === null) {
      return `unrecognized value "${newValue}" for "ECHO_HIDDEN"\nAvailable values are: on, off, noexec.`;
    }
    apply(parsed ? 'on' : 'off');
    return true;
  };
};

/**
 * Parse a non-empty string as a base-10 signed integer. Returns `null` on
 * any junk (mirrors `ParseVariableNum` semantics but without the radix-0
 * extensions — FETCH_COUNT is decimal-only in upstream's eyes).
 */
const parseIntOrNull = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return null;
  if (n < -0x80000000 || n > 0x7fffffff) return null;
  return n;
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
 * Strict validation for non-empty `WATCH_INTERVAL` values. Mirrors
 * upstream's `ParseVariableDouble(name, ..., 0, DEFAULT_WATCH_INTERVAL_MAX)`
 * three distinct error paths:
 *
 *   - junk (strtod doesn't consume it) → `invalid value "<value>" for
 *     variable "WATCH_INTERVAL"`
 *   - parses but value < 0 → `must be greater than 0.00`
 *   - parses but value > 1000000 → `must be less than 1000000.00`
 *
 * Returns `null` if the value is valid; otherwise returns the upstream
 * error string (sent through `trySet`'s hook-veto channel so the prior
 * value is preserved).
 */
const validateWatchInterval = (raw: string): string | null => {
  // strtod-style parse: leading whitespace + sign + (digits[.digits]|.digits)
  // [(eE)±digits]. We're stricter than strtod (no hex/inf), matching the
  // ParseVariableDouble syntax check.
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(raw)) {
    return `invalid value "${raw}" for variable "WATCH_INTERVAL"`;
  }
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) {
    return `invalid value "${raw}" for variable "WATCH_INTERVAL"`;
  }
  if (value < 0) {
    return `invalid value "${raw}" for variable "WATCH_INTERVAL": must be greater than 0.00`;
  }
  if (value > WATCH_INTERVAL_MAX) {
    return `invalid value "${raw}" for variable "WATCH_INTERVAL": must be less than ${WATCH_INTERVAL_MAX.toFixed(2)}`;
  }
  return null;
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
