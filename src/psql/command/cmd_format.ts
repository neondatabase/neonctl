/**
 * Formatting backslash commands.
 *
 * TypeScript port of the `exec_command_a/C/f/H/t/T/x/pset/encoding`
 * implementations in upstream PostgreSQL's `src/bin/psql/command.c` and
 * their backing `do_pset()` / `printPsetInfo()` helpers in the same file.
 *
 * All commands mutate `settings.popt.topt` (a {@link PrintTableOpts}) in
 * place. Several are thin wrappers over `\pset <option>` — for instance
 * `\a` is equivalent to `\pset format aligned|unaligned`. We keep the
 * separate exports so the registry can advertise them under their public
 * names without aliasing oddities.
 *
 * Encoding & connection coupling: `\encoding NAME` should propagate the
 * client encoding to the live connection. The {@link Connection} interface
 * in WP-02 does not yet expose `setClientEncoding`; we guard the call with
 * an `'setClientEncoding' in db` check and leave the upstream-equivalent
 * `// TODO(WP-02)` marker so this lights up once the wire layer ships.
 *
 * Error format: upstream uses `\\<cmd>: <message>` for diagnostics. We
 * mirror that exactly, writing to stderr and returning
 * `{ status: 'error' }`.
 */

import type {
  BackslashCmdSpec,
  BackslashContext,
  BackslashResult,
} from '../types/backslash.js';
import type {
  BorderStyle,
  OutputFormat,
  PrintTableOpts,
  Unicode2BorderStyle,
  Unicode2LineStyle,
} from '../types/printer.js';

import { writeErr, writeOut, parseBool, parseTriple } from './shared.js';

/** Recognised output-format names accepted by `\pset format`. */
const OUTPUT_FORMATS: readonly OutputFormat[] = [
  'aligned',
  'unaligned',
  'wrapped',
  'html',
  'asciidoc',
  'latex',
  'latex-longtable',
  'troff-ms',
  'csv',
  'json',
];

/** Convert OutputFormat to its human-readable display string. */
const formatName = (f: OutputFormat): string => f;

/**
 * Stringify a triple-state for status lines (`\x`, `\pset expanded`).
 * Matches upstream psql phrasing:
 *   on   → "Expanded display is on."
 *   off  → "Expanded display is off."
 *   auto → "Expanded display is used automatically."
 */
const tripleLabel = (value: 'on' | 'off' | 'auto'): string =>
  value === 'auto' ? 'used automatically' : value;

/** `\a` — toggle aligned/unaligned. */
export const cmdA: BackslashCmdSpec = {
  name: 'a',
  helpKey: 'a',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const topt = ctx.settings.popt.topt;
    topt.format = topt.format === 'aligned' ? 'unaligned' : 'aligned';
    return Promise.resolve({ status: 'ok' });
  },
};

/**
 * `\C [title]` — set or clear `topt.title`. No arg clears, any arg sets to
 * that string verbatim. Equivalent to `\pset title [value]`; upstream
 * `exec_command_C` dispatches via `do_pset("title", value, …)` so the
 * status line (`Title is "…".` / `Title is unset.`) is emitted by
 * `printPsetInfo`.
 */
export const cmdC: BackslashCmdSpec = {
  name: 'C',
  helpKey: 'C',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const arg = ctx.nextArg('normal');
    return Promise.resolve(
      applyPset(
        ctx.settings.popt.topt,
        'title',
        arg,
        ctx.cmdName,
        ctx.settings.quiet,
      ),
    );
  },
};

/**
 * `\f [sep]` — set or show the unaligned field separator. With no arg, we
 * print the current value (upstream prints `Field separator is "%s".`).
 */
export const cmdF: BackslashCmdSpec = {
  name: 'f',
  helpKey: 'f',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const arg = ctx.nextArg('normal');
    if (arg === null) {
      writeOut(`Field separator is "${ctx.settings.popt.topt.fieldSep}".\n`);
      return Promise.resolve({ status: 'ok' });
    }
    ctx.settings.popt.topt.fieldSep = arg;
    return Promise.resolve({ status: 'ok' });
  },
};

/**
 * `\H` — toggle html on/off. If currently `html`, flip back to `aligned`;
 * otherwise flip to `html` (upstream remembers the prior format only
 * loosely — we always restore `aligned` to match the documented behaviour).
 */
export const cmdH: BackslashCmdSpec = {
  name: 'H',
  helpKey: 'H',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const topt = ctx.settings.popt.topt;
    topt.format = topt.format === 'html' ? 'aligned' : 'html';
    return Promise.resolve({ status: 'ok' });
  },
};

/**
 * `\t [on|off|toggle]` — tuples-only. No arg → toggle.
 *
 * Equivalent to `\pset tuples_only [value]`; upstream `exec_command_t`
 * dispatches via `do_pset("tuples_only", opt, …)`. The
 * `printPsetInfo("tuples_only")` confirmation line is only emitted when
 * `opt` is NULL (the toggle path) — when a value is supplied,
 * `do_pset` returns early via `ParseVariableBool` and skips
 * `printPsetInfo`, so the status line is suppressed.
 */
export const cmdT: BackslashCmdSpec = {
  name: 't',
  helpKey: 't',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const arg = ctx.nextArg('normal');
    return Promise.resolve(
      applyPset(
        ctx.settings.popt.topt,
        'tuples_only',
        arg,
        ctx.cmdName,
        ctx.settings.quiet,
      ),
    );
  },
};

/**
 * `\T [attr]` — set HTML table attributes. No arg clears. Equivalent to
 * `\pset tableattr [value]`; upstream `exec_command_T` dispatches via
 * `do_pset("tableattr", value, …)` so the status line
 * (`Table attributes are "…".` / `Table attributes unset.`) is emitted
 * by `printPsetInfo`.
 */
export const cmdTitleAttr: BackslashCmdSpec = {
  name: 'T',
  helpKey: 'T',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const arg = ctx.nextArg('normal');
    return Promise.resolve(
      applyPset(
        ctx.settings.popt.topt,
        'tableattr',
        arg,
        ctx.cmdName,
        ctx.settings.quiet,
      ),
    );
  },
};

/** `\x [on|off|auto|toggle]` — expanded output. No arg → toggle. */
export const cmdX: BackslashCmdSpec = {
  name: 'x',
  helpKey: 'x',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const arg = ctx.nextArg('normal');
    const topt = ctx.settings.popt.topt;
    let next: 'on' | 'off' | 'auto';
    if (arg === null) {
      next = topt.expanded === 'on' ? 'off' : 'on';
    } else {
      const parsed = parseTriple(arg);
      if (parsed === null) {
        writeErr(
          `\\${ctx.cmdName}: unrecognized value "${arg}": Boolean expected\n`,
        );
        return Promise.resolve({ status: 'error' });
      }
      if (parsed === 'toggle') {
        next = topt.expanded === 'on' ? 'off' : 'on';
      } else {
        next = parsed;
      }
    }
    topt.expanded = next;
    writeOut(`Expanded display is ${tripleLabel(next)}.\n`);
    return Promise.resolve({ status: 'ok' });
  },
};

/**
 * `\encoding [name]` — show or set the client encoding.
 *
 * No arg: print the current `topt.encoding`. With an arg: update
 * `topt.encoding` and try to push it to the connection. The
 * `setClientEncoding` method isn't on the {@link Connection} interface yet
 * (WP-02), so we guard with an `'in'` check; once that wire-layer landing
 * adds the method, the call lights up automatically.
 */
export const cmdEncoding: BackslashCmdSpec = {
  name: 'encoding',
  helpKey: 'encoding',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const arg = ctx.nextArg('normal');
    if (arg === null) {
      writeOut(`${ctx.settings.popt.topt.encoding}\n`);
      return Promise.resolve({ status: 'ok' });
    }
    ctx.settings.popt.topt.encoding = arg;
    const { db } = ctx.settings;
    // TODO(WP-02): wire setClientEncoding once the Connection interface
    // exposes it. Until then we still mutate topt so prompts/printer see
    // the requested encoding.
    if (db && 'setClientEncoding' in db) {
      const fn = (
        db as unknown as {
          setClientEncoding: (name: string) => unknown;
        }
      ).setClientEncoding;
      try {
        fn(arg);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeErr(`\\${ctx.cmdName}: ${msg}\n`);
        return Promise.resolve({ status: 'error' });
      }
    }
    return Promise.resolve({ status: 'ok' });
  },
};

/**
 * The heart of `\pset`. Given a parsed `option` and optional `value`,
 * mutates `topt` in place and emits the upstream-style status line.
 *
 * Returns `{ status: 'error' }` and writes an error if the value is
 * unrecognised; `{ status: 'ok' }` otherwise.
 *
 * Wording reference: every status line is byte-matched against the
 * `printPsetInfo` table in upstream `src/bin/psql/command.c`. Notable
 * subtleties:
 *
 *  - `tuples_only`, `footer`, and `numericlocale` are silenced when a
 *    value is supplied — upstream `do_pset` returns directly out of
 *    `ParseVariableBool`, never reaching `printPsetInfo`. The toggle
 *    paths still print.
 *  - `recordsep` renders the literal `\n` as the `<newline>` sentinel.
 *  - `columns` reports `0` as `Target width is unset.`.
 *  - `unicode_*_linestyle` uses the multi-word "line style" phrasing
 *    even though the option name itself is a single token.
 *  - `pager_min_lines` pluralizes via `ngettext` — singular at 1, plural
 *    everywhere else (including 0).
 *  - `csv_fieldsep` reports as `Field separator for CSV is "…".`.
 *  - `xheader_width` quotes the named enum values (`"full"`/`"column"`/
 *    `"page"`) and prints the numeric form unquoted.
 */
export const applyPset = (
  topt: PrintTableOpts,
  option: string,
  value: string | null,
  cmdName: string,
  // When `silent` is true, suppress the "X is now Y." status lines that
  // `\pset` emits on a successful set. Errors (invalid option / bad
  // value) still go to stderr. Used by `\g (option=value ...)` —
  // upstream applies the temporary overrides silently.
  silent = false,
): BackslashResult => {
  const writeOutMaybe = silent ? () => undefined : writeOut;
  const opt = option.toLowerCase();
  switch (opt) {
    case 'format': {
      if (value === null) {
        writeOutMaybe(`Output format is ${formatName(topt.format)}.\n`);
        return { status: 'ok' };
      }
      const v = value.toLowerCase();
      const match = OUTPUT_FORMATS.find((f) => f === v);
      if (!match) {
        writeErr(
          `\\${cmdName}: \\pset: allowed formats are aligned, asciidoc, csv, html, json, latex, latex-longtable, troff-ms, unaligned, wrapped\n`,
        );
        return { status: 'error' };
      }
      topt.format = match;
      writeOutMaybe(`Output format is ${formatName(match)}.\n`);
      return { status: 'ok' };
    }
    case 'border': {
      if (value === null) {
        writeOutMaybe(`Border style is ${topt.border}.\n`);
        return { status: 'ok' };
      }
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 0 || n > 3) {
        writeErr(`\\${cmdName}: \\pset: invalid border "${value}"\n`);
        return { status: 'error' };
      }
      topt.border = n as BorderStyle;
      writeOutMaybe(`Border style is ${topt.border}.\n`);
      return { status: 'ok' };
    }
    case 'expanded':
    case 'x': {
      if (value === null) {
        topt.expanded = topt.expanded === 'on' ? 'off' : 'on';
      } else {
        const p = parseTriple(value);
        if (p === null) {
          writeErr(
            `\\${cmdName}: \\pset: unrecognized value "${value}" for "expanded": Boolean expected\n`,
          );
          return { status: 'error' };
        }
        topt.expanded =
          p === 'toggle' ? (topt.expanded === 'on' ? 'off' : 'on') : p;
      }
      writeOutMaybe(`Expanded display is ${tripleLabel(topt.expanded)}.\n`);
      return { status: 'ok' };
    }
    case 'fieldsep': {
      if (value === null) {
        writeOutMaybe(`Field separator is "${topt.fieldSep}".\n`);
        return { status: 'ok' };
      }
      topt.fieldSep = value;
      writeOutMaybe(`Field separator is "${topt.fieldSep}".\n`);
      return { status: 'ok' };
    }
    case 'fieldsep_zero': {
      // Upstream: any value (or none) forces fieldSep to the NUL byte.
      // The bulk-view's `fieldsep_zero` line is derived from fieldSep
      // (on iff fieldSep === '\0').
      topt.fieldSep = '\0';
      writeOutMaybe('Field separator is zero byte.\n');
      return { status: 'ok' };
    }
    case 'footer': {
      if (value !== null) {
        // Upstream `do_pset` returns directly from `ParseVariableBool`
        // for `footer`, bypassing the `printPsetInfo` call entirely
        // — `\pset footer on` is silent, while `\pset footer`
        // (toggle) still prints the new state.
        const b = parseBool(value);
        if (b === null) {
          writeErr(
            `\\${cmdName}: \\pset: unrecognized value "${value}" for "footer": Boolean expected\n`,
          );
          return { status: 'error' };
        }
        topt.defaultFooter = b;
        return { status: 'ok' };
      }
      topt.defaultFooter = !topt.defaultFooter;
      writeOutMaybe(
        topt.defaultFooter
          ? 'Default footer is on.\n'
          : 'Default footer is off.\n',
      );
      return { status: 'ok' };
    }
    case 'recordsep': {
      if (value !== null) {
        topt.recordSep = value;
      }
      // Upstream `printPsetInfo` has three branches: the separator-zero
      // path (handled by the dedicated `recordsep_zero` case), the
      // "<newline>" sentinel for the literal `\n` byte, and the quoted
      // verbatim form for everything else.
      if (topt.recordSep === '\n') {
        writeOutMaybe('Record separator is <newline>.\n');
      } else {
        writeOutMaybe(`Record separator is "${topt.recordSep}".\n`);
      }
      return { status: 'ok' };
    }
    case 'recordsep_zero': {
      topt.recordSep = '\0';
      writeOutMaybe('Record separator is zero byte.\n');
      return { status: 'ok' };
    }
    case 'tuples_only':
    case 't': {
      if (value !== null) {
        // Upstream `do_pset` returns directly from `ParseVariableBool`
        // for `tuples_only`, bypassing `printPsetInfo` — so
        // `\pset tuples_only on` (and the equivalent `\t on`) is
        // silent. The toggle path (no value) still prints.
        const b = parseBool(value);
        if (b === null) {
          writeErr(
            `\\${cmdName}: \\pset: unrecognized value "${value}": Boolean expected\n`,
          );
          return { status: 'error' };
        }
        topt.tuplesOnly = b;
        return { status: 'ok' };
      }
      topt.tuplesOnly = !topt.tuplesOnly;
      writeOutMaybe(
        topt.tuplesOnly ? 'Tuples only is on.\n' : 'Tuples only is off.\n',
      );
      return { status: 'ok' };
    }
    case 'title': {
      topt.title = value;
      if (value === null) {
        writeOutMaybe('Title is unset.\n');
      } else {
        writeOutMaybe(`Title is "${value}".\n`);
      }
      return { status: 'ok' };
    }
    case 'tableattr':
    case 't_a': {
      topt.tableAttr = value;
      if (value === null) {
        writeOutMaybe('Table attributes unset.\n');
      } else {
        writeOutMaybe(`Table attributes are "${value}".\n`);
      }
      return { status: 'ok' };
    }
    case 'pager': {
      if (value === null) {
        topt.pager = topt.pager === 'off' ? 'on' : 'off';
      } else {
        const lower = value.toLowerCase();
        if (lower === 'always') {
          topt.pager = 'always';
        } else if (lower === 'on' || lower === 'off') {
          topt.pager = lower;
        } else {
          const b = parseBool(value);
          if (b === null) {
            writeErr(
              `\\${cmdName}: \\pset: unrecognized value "${value}" for "pager"\n`,
            );
            return { status: 'error' };
          }
          topt.pager = b ? 'on' : 'off';
        }
      }
      writeOutMaybe(
        topt.pager === 'always'
          ? 'Pager is always used.\n'
          : topt.pager === 'on'
            ? 'Pager is used for long output.\n'
            : 'Pager usage is off.\n',
      );
      return { status: 'ok' };
    }
    case 'pager_min_lines': {
      if (value !== null) {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n) || n < 0) {
          writeErr(
            `\\${cmdName}: \\pset: invalid pager_min_lines "${value}"\n`,
          );
          return { status: 'error' };
        }
        topt.pagerMinLines = n;
      }
      // Upstream uses `ngettext` so singular ("line") fires only for
      // n == 1; 0 and 2+ render as "lines".
      const lines = topt.pagerMinLines;
      const unit = lines === 1 ? 'line' : 'lines';
      writeOutMaybe(`Pager won't be used for less than ${lines} ${unit}.\n`);
      return { status: 'ok' };
    }
    case 'null': {
      topt.nullPrint = value ?? '';
      writeOutMaybe(`Null display is "${topt.nullPrint}".\n`);
      return { status: 'ok' };
    }
    case 'csv_fieldsep': {
      if (value !== null) {
        if (
          value.length !== 1 ||
          value === '"' ||
          value === '\n' ||
          value === '\r'
        ) {
          writeErr(
            `\\${cmdName}: \\pset: csv_fieldsep must be a single one-byte character\n`,
          );
          return { status: 'error' };
        }
        topt.csvFieldSep = value;
      }
      // Upstream wording: "Field separator for CSV is "%s".".
      writeOutMaybe(`Field separator for CSV is "${topt.csvFieldSep}".\n`);
      return { status: 'ok' };
    }
    case 'numericlocale': {
      if (value !== null) {
        // Upstream `do_pset` returns directly from `ParseVariableBool`
        // for `numericlocale`, bypassing `printPsetInfo`. The toggle
        // path (no value) still prints the new state.
        const p = parseTriple(value);
        if (p === null || p === 'auto') {
          writeErr(
            `\\${cmdName}: \\pset: unrecognized value "${value}" for "numericlocale": Boolean expected\n`,
          );
          return { status: 'error' };
        }
        topt.numericLocale = p === 'toggle' ? !topt.numericLocale : p === 'on';
        return { status: 'ok' };
      }
      topt.numericLocale = !topt.numericLocale;
      writeOutMaybe(
        topt.numericLocale
          ? 'Locale-adjusted numeric output is on.\n'
          : 'Locale-adjusted numeric output is off.\n',
      );
      return { status: 'ok' };
    }
    case 'linestyle': {
      if (value === null) {
        writeOutMaybe(`Line style is ${topt.unicodeBorderLineStyle}.\n`);
        return { status: 'ok' };
      }
      const lower = value.toLowerCase();
      if (lower === 'ascii' || lower === 'unicode') {
        const ls = lower as Unicode2LineStyle;
        topt.unicodeBorderLineStyle = ls;
        topt.unicodeColumnLineStyle = ls;
        topt.unicodeHeaderLineStyle = ls;
        writeOutMaybe(`Line style is ${ls}.\n`);
        return { status: 'ok' };
      }
      if (lower === 'old-ascii') {
        topt.unicodeBorderLineStyle = 'ascii';
        topt.unicodeColumnLineStyle = 'ascii';
        topt.unicodeHeaderLineStyle = 'ascii';
        writeOutMaybe('Line style is old-ascii.\n');
        return { status: 'ok' };
      }
      writeErr(
        `\\${cmdName}: \\pset: allowed line styles are ascii, old-ascii, unicode\n`,
      );
      return { status: 'error' };
    }
    case 'columns': {
      if (value !== null) {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n) || n < 0) {
          writeErr(`\\${cmdName}: \\pset: invalid columns "${value}"\n`);
          return { status: 'error' };
        }
        topt.columns = n;
      }
      // Upstream `printPsetInfo` reports `0` as the special "unset"
      // sentinel — see `command.c:5433`.
      if (topt.columns === 0) {
        writeOutMaybe('Target width is unset.\n');
      } else {
        writeOutMaybe(`Target width is ${topt.columns}.\n`);
      }
      return { status: 'ok' };
    }
    case 'xheader_width': {
      if (value !== null) {
        const lower = value.toLowerCase();
        if (lower === 'full' || lower === 'column' || lower === 'page') {
          topt.xheaderWidth = lower;
        } else {
          const n = parseInt(value, 10);
          if (
            !Number.isFinite(n) ||
            n <= 0 ||
            !/^[+]?\d+$/.test(value.trim())
          ) {
            writeErr(
              `\\${cmdName}: \\pset: allowed xheader_width values are "full" (default), "column", "page", or a number specifying the exact width\n`,
            );
            return { status: 'error' };
          }
          topt.xheaderWidth = n;
        }
      }
      // Upstream `printPsetInfo` quotes the three named widths
      // ("full" / "column" / "page") but renders the numeric form
      // unquoted as `Expanded header width is 33.`.
      const current = topt.xheaderWidth ?? 'full';
      if (typeof current === 'number') {
        writeOutMaybe(`Expanded header width is ${current}.\n`);
      } else {
        writeOutMaybe(`Expanded header width is "${current}".\n`);
      }
      return { status: 'ok' };
    }
    case 'unicode_border_linestyle':
    case 'unicode_column_linestyle':
    case 'unicode_header_linestyle': {
      // Upstream `printPsetInfo` renders these as
      // `Unicode border line style is "single".` etc. — note the space
      // between "line" and "style" in the message (the option name
      // itself is one token, `linestyle`).
      const which =
        opt === 'unicode_border_linestyle'
          ? 'border'
          : opt === 'unicode_column_linestyle'
            ? 'column'
            : 'header';
      if (value !== null) {
        const lower = value.toLowerCase();
        if (lower !== 'single' && lower !== 'double') {
          writeErr(`\\${cmdName}: \\pset: ${opt} must be single or double\n`);
          return { status: 'error' };
        }
        const style: Unicode2BorderStyle = lower;
        if (opt === 'unicode_border_linestyle') {
          topt.unicodeBorderStyle = style;
        } else if (opt === 'unicode_column_linestyle') {
          topt.unicodeColumnStyle = style;
        } else {
          topt.unicodeHeaderStyle = style;
        }
      }
      const current =
        opt === 'unicode_border_linestyle'
          ? (topt.unicodeBorderStyle ?? 'single')
          : opt === 'unicode_column_linestyle'
            ? (topt.unicodeColumnStyle ?? 'single')
            : (topt.unicodeHeaderStyle ?? 'single');
      writeOutMaybe(`Unicode ${which} line style is "${current}".\n`);
      return { status: 'ok' };
    }
    default: {
      writeErr(`\\${cmdName}: \\pset: unknown option "${option}"\n`);
      return { status: 'error' };
    }
  }
};

/**
 * Wrap a string value in single quotes, escaping embedded newlines and
 * single quotes. Mirrors upstream `pset_quoted_string` in
 * `src/bin/psql/command.c` — used by the bulk-view formatter so the
 * emitted line can be fed back into `\pset NAME VALUE`.
 */
const psetQuotedString = (str: string): string => {
  let out = "'";
  for (const ch of str) {
    if (ch === '\n') out += '\\n';
    else if (ch === "'") out += "\\'";
    else out += ch;
  }
  out += "'";
  return out;
};

/**
 * Render the numeric pager encoding upstream uses in `printPsetInfo`:
 * 0 = never, 1 = "if needed" (our `'on'`), 2 = always. We keep
 * `topt.pager` as the upstream-style triple ('off'|'on'|'always') for
 * `applyPset`'s state machine; this is only the bulk-view conversion.
 */
const pagerNumeric = (pager: PrintTableOpts['pager']): number =>
  pager === 'off' ? 0 : pager === 'on' ? 1 : 2;

/**
 * Render `xheader_width` for the bulk view. Enum values print verbatim;
 * numeric values print as the integer.
 */
const xheaderWidthDisplay = (
  w: NonNullable<PrintTableOpts['xheaderWidth']>,
): string => (typeof w === 'number' ? String(w) : w);

/**
 * Print the full current `\pset` state, one option per line, to stdout.
 * Used when `\pset` is invoked with no arguments. String-valued settings
 * are single-quoted (matching upstream `pset_value_string`); `tableattr`
 * and `title` are unquoted-empty when unset. The set, ordering, and
 * column-spacing mirror `printPsetInfo` in `src/bin/psql/command.c`.
 */
const printAllPset = (topt: PrintTableOpts): void => {
  writeOut(`border                   ${topt.border}\n`);
  writeOut(`columns                  ${topt.columns}\n`);
  writeOut(`csv_fieldsep             ${psetQuotedString(topt.csvFieldSep)}\n`);
  writeOut(`expanded                 ${topt.expanded}\n`);
  writeOut(`fieldsep                 ${psetQuotedString(topt.fieldSep)}\n`);
  // fieldsep_zero / recordsep_zero are derived: upstream emits "on" iff
  // the corresponding separator is the NUL byte.
  writeOut(
    `fieldsep_zero            ${topt.fieldSep === '\0' ? 'on' : 'off'}\n`,
  );
  writeOut(`footer                   ${topt.defaultFooter ? 'on' : 'off'}\n`);
  writeOut(`format                   ${topt.format}\n`);
  writeOut(`linestyle                ${topt.unicodeBorderLineStyle}\n`);
  writeOut(`null                     ${psetQuotedString(topt.nullPrint)}\n`);
  writeOut(`numericlocale            ${topt.numericLocale ? 'on' : 'off'}\n`);
  // pager is emitted numerically (0/1/2) — upstream uses %d in printPsetInfo.
  writeOut(`pager                    ${pagerNumeric(topt.pager)}\n`);
  writeOut(`pager_min_lines          ${topt.pagerMinLines}\n`);
  writeOut(`recordsep                ${psetQuotedString(topt.recordSep)}\n`);
  writeOut(
    `recordsep_zero           ${topt.recordSep === '\0' ? 'on' : 'off'}\n`,
  );
  writeOut(
    `tableattr                ${topt.tableAttr === null ? '' : psetQuotedString(topt.tableAttr)}\n`,
  );
  writeOut(
    `title                    ${topt.title === null ? '' : psetQuotedString(topt.title)}\n`,
  );
  writeOut(`tuples_only              ${topt.tuplesOnly ? 'on' : 'off'}\n`);
  writeOut(`unicode_border_linestyle ${topt.unicodeBorderStyle ?? 'single'}\n`);
  writeOut(`unicode_column_linestyle ${topt.unicodeColumnStyle ?? 'single'}\n`);
  writeOut(`unicode_header_linestyle ${topt.unicodeHeaderStyle ?? 'single'}\n`);
  writeOut(
    `xheader_width            ${xheaderWidthDisplay(topt.xheaderWidth ?? 'full')}\n`,
  );
};

/**
 * `\pset [option [value]]` — the master print-options setter.
 *
 * - No args: print all options.
 * - Option only: toggle (for booleans) or show current value.
 * - Option + value: set.
 */
export const cmdPset: BackslashCmdSpec = {
  name: 'pset',
  helpKey: 'pset',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const option = ctx.nextArg('normal');
    if (option === null) {
      printAllPset(ctx.settings.popt.topt);
      return Promise.resolve({ status: 'ok' });
    }
    const value = ctx.nextArg('normal');
    // Under `--quiet` / `\set QUIET on`, upstream `exec_command_pset`
    // (and the printPsetInfo helper it delegates to) suppresses the
    // confirmation lines like `Null display is "…".` and `Tuples only
    // is on.`. Pass `silent=true` so applyPset skips the writes —
    // errors (invalid option / bad value) still go to stderr.
    return Promise.resolve(
      applyPset(
        ctx.settings.popt.topt,
        option,
        value,
        ctx.cmdName,
        ctx.settings.quiet,
      ),
    );
  },
};
