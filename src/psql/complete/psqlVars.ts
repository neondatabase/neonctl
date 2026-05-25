/**
 * Static-list completion candidates for psql special variables, settings,
 * and the small enums their values take.
 *
 * The values come from `pset_lookup_option` and the var-hook table in psql
 * (`src/bin/psql/variables.c` + `command.c`). We keep this module pure data
 * so it's trivial to extend as new variables are added in later WPs.
 */

/** All psql special variables (anything that has a hook in variables.c). */
export const SPECIAL_VARIABLES: readonly string[] = [
  'AUTOCOMMIT',
  'COMP_KEYWORD_CASE',
  'DBNAME',
  'ECHO',
  'ECHO_HIDDEN',
  'ENCODING',
  'ERROR',
  'FETCH_COUNT',
  'HIDE_TABLEAM',
  'HIDE_TOAST_COMPRESSION',
  'HISTCONTROL',
  'HISTFILE',
  'HISTSIZE',
  'HOST',
  'IGNOREEOF',
  'LASTOID',
  'LAST_ERROR_MESSAGE',
  'LAST_ERROR_SQLSTATE',
  'ON_ERROR_ROLLBACK',
  'ON_ERROR_STOP',
  'PORT',
  'PROMPT1',
  'PROMPT2',
  'PROMPT3',
  'QUIET',
  'ROW_COUNT',
  'SERVER_VERSION_NAME',
  'SERVER_VERSION_NUM',
  'SHELL_ERROR',
  'SHELL_EXIT_CODE',
  'SHOW_ALL_RESULTS',
  'SHOW_CONTEXT',
  'SINGLELINE',
  'SINGLESTEP',
  'SQLSTATE',
  'USER',
  'VERBOSITY',
  'VERSION',
  'VERSION_NAME',
  'VERSION_NUM',
];

/** `\pset` option names. */
export const PSET_OPTIONS: readonly string[] = [
  'border',
  'columns',
  'csv_fieldsep',
  'expanded',
  'fieldsep',
  'fieldsep_zero',
  'footer',
  'format',
  'linestyle',
  'null',
  'numericlocale',
  'pager',
  'pager_min_lines',
  'recordsep',
  'recordsep_zero',
  'tableattr',
  'title',
  'tuples_only',
  'unicode_border_linestyle',
  'unicode_column_linestyle',
  'unicode_header_linestyle',
  'xheader_width',
];

/** Output formats accepted by `\pset format`. */
export const PSET_FORMATS: readonly string[] = [
  'aligned',
  'asciidoc',
  'csv',
  'html',
  'latex',
  'latex-longtable',
  'troff-ms',
  'unaligned',
  'wrapped',
];

/** Line styles accepted by `\pset linestyle`. */
export const PSET_LINESTYLES: readonly string[] = [
  'ascii',
  'old-ascii',
  'unicode',
];

/** Unicode border/column/header line styles. */
export const PSET_UNICODE_STYLES: readonly string[] = ['single', 'double'];

/** `xheader_width` argument forms. */
export const PSET_XHEADER_WIDTHS: readonly string[] = [
  'column',
  'full',
  'page',
];

/** On/off/auto enum, used by many variables. */
export const ON_OFF: readonly string[] = ['on', 'off'];
export const ON_OFF_AUTO: readonly string[] = ['on', 'off', 'auto'];

/** Echo modes. */
export const ECHO_MODES: readonly string[] = [
  'none',
  'errors',
  'queries',
  'all',
];
export const ECHO_HIDDEN_MODES: readonly string[] = ['off', 'on', 'noexec'];
export const ON_ERROR_ROLLBACK_MODES: readonly string[] = [
  'off',
  'on',
  'interactive',
];
export const VERBOSITY_MODES: readonly string[] = [
  'default',
  'verbose',
  'terse',
  'sqlstate',
];
export const SHOW_CONTEXT_MODES: readonly string[] = [
  'never',
  'errors',
  'always',
];
export const COMP_KEYWORD_CASE_MODES: readonly string[] = [
  'lower',
  'upper',
  'preserve-lower',
  'preserve-upper',
];
export const HIST_CONTROL_MODES: readonly string[] = [
  'none',
  'ignorespace',
  'ignoredups',
  'ignoreboth',
];

/** A handful of common client encodings — enough to be useful at `\encoding`. */
export const ENCODINGS: readonly string[] = [
  'BIG5',
  'EUC_CN',
  'EUC_JIS_2004',
  'EUC_JP',
  'EUC_KR',
  'EUC_TW',
  'GB18030',
  'GBK',
  'ISO_8859_5',
  'ISO_8859_6',
  'ISO_8859_7',
  'ISO_8859_8',
  'JOHAB',
  'KOI8R',
  'KOI8U',
  'LATIN1',
  'LATIN2',
  'LATIN3',
  'LATIN4',
  'LATIN5',
  'LATIN6',
  'LATIN7',
  'LATIN8',
  'LATIN9',
  'LATIN10',
  'MULE_INTERNAL',
  'SJIS',
  'SHIFT_JIS_2004',
  'SQL_ASCII',
  'UHC',
  'UTF8',
  'WIN866',
  'WIN874',
  'WIN1250',
  'WIN1251',
  'WIN1252',
  'WIN1253',
  'WIN1254',
  'WIN1255',
  'WIN1256',
  'WIN1257',
  'WIN1258',
];

/**
 * For a given `\pset` option, return the list of values it accepts. Returns
 * `null` for free-form options (title, fieldsep, etc.).
 */
export const psetValuesFor = (option: string): readonly string[] | null => {
  switch (option) {
    case 'format':
      return PSET_FORMATS;
    case 'linestyle':
      return PSET_LINESTYLES;
    case 'unicode_border_linestyle':
    case 'unicode_column_linestyle':
    case 'unicode_header_linestyle':
      return PSET_UNICODE_STYLES;
    case 'xheader_width':
      return PSET_XHEADER_WIDTHS;
    case 'expanded':
    case 'pager':
      return ON_OFF_AUTO;
    case 'footer':
    case 'tuples_only':
    case 'numericlocale':
    case 'fieldsep_zero':
    case 'recordsep_zero':
      return ON_OFF;
    default:
      return null;
  }
};

/**
 * For a given special variable, return acceptable values, or `null` if free-form.
 */
export const variableValuesFor = (name: string): readonly string[] | null => {
  switch (name) {
    case 'AUTOCOMMIT':
    case 'ON_ERROR_STOP':
    case 'QUIET':
    case 'SINGLELINE':
    case 'SINGLESTEP':
    case 'SHOW_ALL_RESULTS':
    case 'HIDE_TOAST_COMPRESSION':
    case 'HIDE_TABLEAM':
      return ON_OFF;
    case 'ECHO':
      return ECHO_MODES;
    case 'ECHO_HIDDEN':
      return ECHO_HIDDEN_MODES;
    case 'ON_ERROR_ROLLBACK':
      return ON_ERROR_ROLLBACK_MODES;
    case 'VERBOSITY':
      return VERBOSITY_MODES;
    case 'SHOW_CONTEXT':
      return SHOW_CONTEXT_MODES;
    case 'COMP_KEYWORD_CASE':
      return COMP_KEYWORD_CASE_MODES;
    case 'HISTCONTROL':
      return HIST_CONTROL_MODES;
    default:
      return null;
  }
};
