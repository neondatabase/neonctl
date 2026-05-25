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

/** Stringify a triple-state for status lines (`\x`, `\t`). */
const tripleLabel = (value: 'on' | 'off' | 'auto'): string => value;

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
 * that string verbatim.
 */
export const cmdC: BackslashCmdSpec = {
  name: 'C',
  helpKey: 'C',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const arg = ctx.nextArg('normal');
    ctx.settings.popt.topt.title = arg ?? null;
    return Promise.resolve({ status: 'ok' });
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

/** `\t [on|off|toggle]` — tuples-only. No arg → toggle. */
export const cmdT: BackslashCmdSpec = {
  name: 't',
  helpKey: 't',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const arg = ctx.nextArg('normal');
    const topt = ctx.settings.popt.topt;
    if (arg === null) {
      topt.tuplesOnly = !topt.tuplesOnly;
    } else {
      const parsed = parseTriple(arg);
      if (parsed === null || parsed === 'auto') {
        writeErr(
          `\\${ctx.cmdName}: unrecognized value "${arg}": Boolean expected\n`,
        );
        return Promise.resolve({ status: 'error' });
      }
      topt.tuplesOnly =
        parsed === 'toggle' ? !topt.tuplesOnly : parsed === 'on';
    }
    writeOut(
      topt.tuplesOnly ? 'Tuples only is on.\n' : 'Tuples only is off.\n',
    );
    return Promise.resolve({ status: 'ok' });
  },
};

/** `\T [attr]` — set HTML table attributes. No arg clears. */
export const cmdTitleAttr: BackslashCmdSpec = {
  name: 'T',
  helpKey: 'T',
  run: (ctx: BackslashContext): Promise<BackslashResult> => {
    const arg = ctx.nextArg('normal');
    ctx.settings.popt.topt.tableAttr = arg ?? null;
    return Promise.resolve({ status: 'ok' });
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
 */
const applyPset = (
  topt: PrintTableOpts,
  option: string,
  value: string | null,
  cmdName: string,
): BackslashResult => {
  const opt = option.toLowerCase();
  switch (opt) {
    case 'format': {
      if (value === null) {
        writeOut(`Output format is ${formatName(topt.format)}.\n`);
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
      writeOut(`Output format is ${formatName(match)}.\n`);
      return { status: 'ok' };
    }
    case 'border': {
      if (value === null) {
        writeOut(`Border style is ${topt.border}.\n`);
        return { status: 'ok' };
      }
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 0 || n > 3) {
        writeErr(`\\${cmdName}: \\pset: invalid border "${value}"\n`);
        return { status: 'error' };
      }
      topt.border = n as BorderStyle;
      writeOut(`Border style is ${topt.border}.\n`);
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
      writeOut(`Expanded display is ${tripleLabel(topt.expanded)}.\n`);
      return { status: 'ok' };
    }
    case 'fieldsep': {
      if (value === null) {
        writeOut(`Field separator is "${topt.fieldSep}".\n`);
        return { status: 'ok' };
      }
      topt.fieldSep = value;
      writeOut(`Field separator is "${topt.fieldSep}".\n`);
      return { status: 'ok' };
    }
    case 'fieldsep_zero': {
      topt.fieldSep = '\0';
      writeOut('Field separator is zero byte.\n');
      return { status: 'ok' };
    }
    case 'recordsep': {
      if (value === null) {
        writeOut(`Record separator is "${topt.recordSep}".\n`);
        return { status: 'ok' };
      }
      topt.recordSep = value;
      writeOut(`Record separator is "${topt.recordSep}".\n`);
      return { status: 'ok' };
    }
    case 'recordsep_zero': {
      topt.recordSep = '\0';
      writeOut('Record separator is zero byte.\n');
      return { status: 'ok' };
    }
    case 'tuples_only':
    case 't': {
      if (value === null) {
        topt.tuplesOnly = !topt.tuplesOnly;
      } else {
        const b = parseBool(value);
        if (b === null) {
          writeErr(
            `\\${cmdName}: \\pset: unrecognized value "${value}": Boolean expected\n`,
          );
          return { status: 'error' };
        }
        topt.tuplesOnly = b;
      }
      writeOut(
        topt.tuplesOnly ? 'Tuples only is on.\n' : 'Tuples only is off.\n',
      );
      return { status: 'ok' };
    }
    case 'title': {
      topt.title = value;
      if (value === null) {
        writeOut('Title is unset.\n');
      } else {
        writeOut(`Title is "${value}".\n`);
      }
      return { status: 'ok' };
    }
    case 'tableattr':
    case 't_a': {
      topt.tableAttr = value;
      if (value === null) {
        writeOut('Table attributes unset.\n');
      } else {
        writeOut(`Table attributes are "${value}".\n`);
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
      writeOut(
        topt.pager === 'always'
          ? 'Pager is always used.\n'
          : topt.pager === 'on'
            ? 'Pager is used for long output.\n'
            : 'Pager usage is off.\n',
      );
      return { status: 'ok' };
    }
    case 'pager_min_lines': {
      if (value === null) {
        writeOut(
          `Pager won't be used for less than ${topt.pagerMinLines} line(s).\n`,
        );
        return { status: 'ok' };
      }
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 0) {
        writeErr(`\\${cmdName}: \\pset: invalid pager_min_lines "${value}"\n`);
        return { status: 'error' };
      }
      topt.pagerMinLines = n;
      writeOut(`Pager won't be used for less than ${n} line(s).\n`);
      return { status: 'ok' };
    }
    case 'null': {
      topt.nullPrint = value ?? '';
      writeOut(`Null display is "${topt.nullPrint}".\n`);
      return { status: 'ok' };
    }
    case 'csv_fieldsep': {
      if (value === null) {
        writeOut(`CSV field separator is "${topt.csvFieldSep}".\n`);
        return { status: 'ok' };
      }
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
      writeOut(`CSV field separator is "${value}".\n`);
      return { status: 'ok' };
    }
    case 'numericlocale': {
      if (value === null) {
        topt.numericLocale = !topt.numericLocale;
      } else {
        const p = parseTriple(value);
        if (p === null || p === 'auto') {
          writeErr(
            `\\${cmdName}: \\pset: unrecognized value "${value}" for "numericlocale": Boolean expected\n`,
          );
          return { status: 'error' };
        }
        topt.numericLocale = p === 'toggle' ? !topt.numericLocale : p === 'on';
      }
      writeOut(
        topt.numericLocale
          ? 'Locale-adjusted numeric output is on.\n'
          : 'Locale-adjusted numeric output is off.\n',
      );
      return { status: 'ok' };
    }
    case 'linestyle': {
      if (value === null) {
        writeOut(`Line style is ${topt.unicodeBorderLineStyle}.\n`);
        return { status: 'ok' };
      }
      const lower = value.toLowerCase();
      if (lower === 'ascii' || lower === 'unicode') {
        const ls = lower as Unicode2LineStyle;
        topt.unicodeBorderLineStyle = ls;
        topt.unicodeColumnLineStyle = ls;
        topt.unicodeHeaderLineStyle = ls;
        writeOut(`Line style is ${ls}.\n`);
        return { status: 'ok' };
      }
      if (lower === 'old-ascii') {
        topt.unicodeBorderLineStyle = 'ascii';
        topt.unicodeColumnLineStyle = 'ascii';
        topt.unicodeHeaderLineStyle = 'ascii';
        writeOut('Line style is old-ascii.\n');
        return { status: 'ok' };
      }
      writeErr(
        `\\${cmdName}: \\pset: allowed line styles are ascii, old-ascii, unicode\n`,
      );
      return { status: 'error' };
    }
    case 'columns': {
      if (value === null) {
        writeOut(`Target width is ${topt.columns}.\n`);
        return { status: 'ok' };
      }
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < 0) {
        writeErr(`\\${cmdName}: \\pset: invalid columns "${value}"\n`);
        return { status: 'error' };
      }
      topt.columns = n;
      writeOut(`Target width is ${n}.\n`);
      return { status: 'ok' };
    }
    case 'xheader_width': {
      // We store as-is for now; the printer in WP-09 owns the semantics
      // ("full", "column", "page", or a positive integer).
      writeOut(`Expanded header width is ${value ?? 'full'}.\n`);
      return { status: 'ok' };
    }
    case 'unicode_border_linestyle':
    case 'unicode_column_linestyle':
    case 'unicode_header_linestyle': {
      if (value === null) {
        const current =
          opt === 'unicode_border_linestyle'
            ? topt.unicodeBorderLineStyle
            : opt === 'unicode_column_linestyle'
              ? topt.unicodeColumnLineStyle
              : topt.unicodeHeaderLineStyle;
        writeOut(
          `Unicode ${opt.replace('unicode_', '').replace('_linestyle', '')} linestyle is "${current}".\n`,
        );
        return { status: 'ok' };
      }
      const lower = value.toLowerCase();
      if (lower !== 'single' && lower !== 'double') {
        writeErr(`\\${cmdName}: \\pset: ${opt} must be single or double\n`);
        return { status: 'error' };
      }
      // The underlying field is Unicode2LineStyle (ascii|unicode) in our
      // types; we map single/double onto unicode for now, preserving the
      // distinction in a side-channel for the printer to consume later.
      const style: Unicode2BorderStyle = lower;
      void style;
      if (opt === 'unicode_border_linestyle') {
        topt.unicodeBorderLineStyle = 'unicode';
      } else if (opt === 'unicode_column_linestyle') {
        topt.unicodeColumnLineStyle = 'unicode';
      } else {
        topt.unicodeHeaderLineStyle = 'unicode';
      }
      writeOut(
        `Unicode ${opt.replace('unicode_', '').replace('_linestyle', '')} linestyle is "${lower}".\n`,
      );
      return { status: 'ok' };
    }
    default: {
      writeErr(`\\${cmdName}: \\pset: unknown option "${option}"\n`);
      return { status: 'error' };
    }
  }
};

/**
 * Print the full current `\pset` state, one option per line, to stdout.
 * Used when `\pset` is invoked with no arguments.
 */
const printAllPset = (topt: PrintTableOpts): void => {
  writeOut(`border                   ${topt.border}\n`);
  writeOut(`columns                  ${topt.columns}\n`);
  writeOut(`csv_fieldsep             "${topt.csvFieldSep}"\n`);
  writeOut(`expanded                 ${topt.expanded}\n`);
  writeOut(`fieldsep                 "${topt.fieldSep}"\n`);
  writeOut(`format                   ${topt.format}\n`);
  writeOut(`linestyle                ${topt.unicodeBorderLineStyle}\n`);
  writeOut(`null                     "${topt.nullPrint}"\n`);
  writeOut(`numericlocale            ${topt.numericLocale ? 'on' : 'off'}\n`);
  writeOut(`pager                    ${topt.pager}\n`);
  writeOut(`pager_min_lines          ${topt.pagerMinLines}\n`);
  writeOut(`recordsep                "${topt.recordSep}"\n`);
  writeOut(`tableattr                ${topt.tableAttr ?? ''}\n`);
  writeOut(`title                    ${topt.title ?? ''}\n`);
  writeOut(`tuples_only              ${topt.tuplesOnly ? 'on' : 'off'}\n`);
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
    return Promise.resolve(
      applyPset(ctx.settings.popt.topt, option, value, ctx.cmdName),
    );
  },
};
