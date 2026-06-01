/**
 * psql startup-args parser + applier.
 *
 * TypeScript port of `parse_psql_options()` / the top of `main()` in
 * `src/bin/psql/startup.c`. Two responsibilities:
 *
 *   1. `parseStartupArgs(argv)` — hand-written getopt_long-equivalent that
 *      walks the argv array once, decoding short (`-c`) and long (`--command`)
 *      options, and accumulates an ordered list of `-c`/`-f` actions plus a
 *      bag of settings flags. Positional arguments follow the upstream
 *      `[DBNAME [USERNAME]]` rule.
 *
 *      We hand-roll the parser instead of pulling in `yargs` (or similar)
 *      because upstream psql has subtle precedence rules — actions are
 *      ordered, `-v NAME` without `=` deletes the variable, `-X` interacts
 *      with `.psqlrc` discovery, etc. The parser stays under ~250 LOC and is
 *      fully covered by unit tests.
 *
 *   2. `applyStartupArgs(args, settings, baseConnect)` — mutates `settings`
 *      (and its var store) in-place to reflect parsed flags, then returns
 *      the connect options the caller should use plus the ordered list of
 *      pre-REPL actions to execute (currently just `-c` / `-f`).
 *
 * Out-of-scope for WP-26 but the table mentions them so they're listed below:
 *   - `-1` / `--single-transaction` — we accept and record on the args but
 *     do not wire its semantics in the caller. Tracked for a follow-up.
 *   - `-C` — accepted as a no-op (since-PG17 connection-check skip).
 *   - `-l` / `--list` — recorded; the caller may use it later to short-circuit
 *     the REPL with a `\l` and exit. Not wired here.
 *   - `-L logfile`, `-o output` — recorded on args. Routing into the printer
 *     is owned by other WPs (logfile streaming and output redirection).
 *   - `--help[=topic]` — returns a ParseError with `kind: 'help'` and the
 *     help text already rendered as `message`. Caller writes and exits 0.
 *   - `-V` / `--version` — returns `kind: 'version'` with the version string.
 *     Caller writes and exits 0.
 *
 * Help/version text is rendered through `./help.ts` so the formatting stays
 * in lock-step with `\?` output (WP-18). The version string mirrors upstream
 * `psql (PostgreSQL) PG_VERSION` and is currently hard-coded — the embedded
 * psql doesn't have a build-system PG_VERSION constant. A follow-up could
 * surface the real PG version from a const, but for now we expose the
 * embedded build's version label.
 */

import type { ConnectOptions } from '../types/connection.js';
import type { PsqlSettings } from '../types/settings.js';
import type { PgPassEntry } from '../io/pgpass.js';
import type { ServiceEntry } from '../io/pgservice.js';

import {
  envConnectionDefaults,
  libpqConnectionDefaults,
  looksLikeConnectionString,
  mergeConnectOptions,
  parseConninfo,
  parseConnectionUri,
  serviceEntryToConnectOptions,
} from '../index.js';
import { lookupPgPass } from '../io/pgpass.js';

import { helpVariables, slashUsage, usage } from './help.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export type StartupAction =
  | { kind: 'command'; sql: string }
  | { kind: 'file'; path: string };

export type StartupVariable = { name: string; value: string };

export type ParsedArgs = {
  /** Connection target overrides. */
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  promptPassword?: boolean;
  database?: string;
  /**
   * Walsender (replication) mode, derived from a conninfo-style `-d` value
   * (e.g. `dbname=postgres replication=database`). The URI path threads
   * `?replication=…` straight through `parseConnectionUri` instead.
   */
  replication?: 'true' | 'database';

  /** Initial actions ordered as (-c|-f) appear on the command line. */
  actions: readonly StartupAction[];

  /** Variable assignments (-v / --set / --variable NAME=VALUE). */
  variables: readonly StartupVariable[];

  /** Settings flags. */
  noPsqlrc: boolean;
  noReadline: boolean;
  echoAll: boolean;
  echoHidden: 'off' | 'on' | 'noexec';
  echoErrors: boolean;
  echoQueries: boolean;
  quiet: boolean;
  singleline: boolean;
  singlestep: boolean;
  noAlign: boolean;
  noPager: boolean;
  htmlMode: boolean;
  tuplesOnly: boolean;
  expanded: boolean;
  csvOutput: boolean;
  onErrorStop: boolean;
  fieldSep?: string;
  recordSep?: string;
  fieldSepZero: boolean;
  recordSepZero: boolean;
  log?: string;
  output?: string;
  pset: readonly string[];
  list: boolean;
  singleTransaction: boolean;

  /** Help/version flags consumed at the top, ignored downstream. */
  help: boolean;
  version: boolean;

  /** Positional args: <DBNAME> [USERNAME]. */
  positional: string[];
};

export type ParseError = {
  kind: 'invalid-option' | 'missing-arg' | 'invalid-value' | 'help' | 'version';
  message: string;
};

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

/** Short options that consume the next argv slot (or attached value). */
const SHORT_WITH_ARG = new Set([
  'c',
  'd',
  'f',
  'F',
  'h',
  'L',
  'o',
  'p',
  'P',
  'R',
  'T',
  'U',
  'v',
]);

/** Short flags (no argument). */
const SHORT_NO_ARG = new Set([
  'a',
  'A',
  'b',
  'C',
  'e',
  'E',
  'H',
  'l',
  'n',
  'q',
  's',
  'S',
  't',
  'V',
  'w',
  'W',
  'x',
  'X',
  'z',
  '0',
  '1',
  '?',
]);

/** Long option → canonical short equivalent (or sentinel string). */
const LONG_MAP: Record<string, string> = {
  'echo-all': 'a',
  'no-align': 'A',
  command: 'c',
  dbname: 'd',
  'echo-queries': 'e',
  'echo-errors': 'b',
  'echo-hidden': 'E',
  file: 'f',
  'field-separator': 'F',
  'field-separator-zero': 'z',
  host: 'h',
  html: 'H',
  list: 'l',
  'log-file': 'L',
  'no-readline': 'n',
  'single-transaction': '1',
  output: 'o',
  port: 'p',
  pset: 'P',
  quiet: 'q',
  'record-separator': 'R',
  'record-separator-zero': '0',
  'single-step': 's',
  'single-line': 'S',
  'tuples-only': 't',
  'table-attr': 'T',
  username: 'U',
  set: 'v',
  variable: 'v',
  version: 'V',
  'no-password': 'w',
  password: 'W',
  expanded: 'x',
  'no-psqlrc': 'X',
  'no-pager': '__no_pager__',
  'on-error-stop': '__on_error_stop__',
  help: '__help__',
  csv: '__csv__',
};

/** Long options that REQUIRE an attached value (or one in the next argv). */
const LONG_WITH_ARG = new Set([
  'command',
  'dbname',
  'file',
  'field-separator',
  'host',
  'log-file',
  'output',
  'port',
  'pset',
  'record-separator',
  'table-attr',
  'username',
  'set',
  'variable',
]);

/** Long options whose value is optional (only attached with `=`). */
const LONG_OPTIONAL_ARG = new Set(['help', 'echo-hidden']);

const blankArgs = (): ParsedArgs => ({
  actions: [],
  variables: [],
  noPsqlrc: false,
  noReadline: false,
  echoAll: false,
  echoHidden: 'off',
  echoErrors: false,
  echoQueries: false,
  quiet: false,
  singleline: false,
  singlestep: false,
  noAlign: false,
  noPager: false,
  htmlMode: false,
  tuplesOnly: false,
  expanded: false,
  csvOutput: false,
  onErrorStop: false,
  fieldSepZero: false,
  recordSepZero: false,
  pset: [],
  list: false,
  singleTransaction: false,
  help: false,
  version: false,
  positional: [],
});

const renderToString = (fn: (out: NodeJS.WritableStream) => void): string => {
  const chunks: string[] = [];
  const sink = {
    write(chunk: string | Uint8Array): boolean {
      chunks.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
      );
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  fn(sink);
  return chunks.join('');
};

const renderHelp = (topic: string | undefined): string => {
  if (topic === undefined || topic === 'options') {
    return renderToString((out) => {
      usage(out);
    });
  }
  if (topic === 'commands') {
    return renderToString((out) => {
      slashUsage(out, false);
    });
  }
  if (topic === 'variables') {
    return renderToString((out) => {
      helpVariables(out);
    });
  }
  return '';
};

const VERSION_STRING = 'psql (PostgreSQL) embedded-ts';

const pushAction = (acts: StartupAction[], a: StartupAction): void => {
  acts.push(a);
};

const pushVariable = (vars: StartupVariable[], raw: string): void => {
  const eq = raw.indexOf('=');
  if (eq < 0) {
    // psql treats `-v NAME` (no value) as "delete this variable". We surface
    // an empty value; the caller decides whether to set or unset. Tests
    // verify both shapes.
    vars.push({ name: raw, value: '' });
    return;
  }
  vars.push({ name: raw.slice(0, eq), value: raw.slice(eq + 1) });
};

/**
 * `-d VALUE` resolution. libpq accepts three shapes for the value:
 *
 *   1. Bare database name (no `=`, no `postgres[ql]://` prefix) — set
 *      `args.database` directly. This is by far the common case.
 *   2. Connection URI (`postgresql://…` / `postgres://…`) — parse it and
 *      lift the fields it specifies onto `args` (host, port, user, etc.).
 *   3. Conninfo key=value pairs separated by whitespace — same, but parsed
 *      via `parseConninfo`.
 *
 * The test corpus for upstream `001_basic.pl` uses shape (3) to open a
 * walsender connection: `-d "dbname=postgres replication=database"`. We
 * fold any conninfo-only fields (currently only `replication`) onto a
 * dedicated `args.replication` slot that `applyStartupArgs` threads into
 * `ConnectOptions.replication`.
 */
const applyDashD = (args: ParsedArgs, value: string): void => {
  if (!looksLikeConnectionString(value)) {
    args.database = value;
    return;
  }
  const parsed: Partial<ConnectOptions> =
    value.startsWith('postgresql://') || value.startsWith('postgres://')
      ? parseConnectionUri(value)
      : parseConninfo(value);
  if (parsed.host !== undefined && args.host === undefined) {
    args.host = parsed.host;
  }
  if (parsed.port !== undefined && args.port === undefined) {
    args.port = parsed.port;
  }
  if (parsed.user !== undefined && args.user === undefined) {
    args.user = parsed.user;
  }
  if (parsed.password !== undefined && args.password === undefined) {
    args.password = parsed.password;
  }
  if (parsed.database !== undefined && args.database === undefined) {
    args.database = parsed.database;
  }
  if (parsed.replication !== undefined) {
    args.replication = parsed.replication;
  }
};

// ---------------------------------------------------------------------------
// parseStartupArgs.
// ---------------------------------------------------------------------------

export const parseStartupArgs = (argv: string[]): ParsedArgs | ParseError => {
  const args = blankArgs();
  const actions: StartupAction[] = [];
  const variables: StartupVariable[] = [];
  const pset: string[] = [];

  let i = 0;
  const n = argv.length;

  const needValue = (flagDisplay: string): string | ParseError => {
    if (i + 1 >= n) {
      return {
        kind: 'missing-arg',
        message: `option requires an argument -- ${flagDisplay}`,
      };
    }
    i += 1;
    return argv[i];
  };

  const applyShort = (
    letter: string,
    attachedValue: string | undefined,
    flagDisplay: string,
  ): null | ParseError => {
    // Resolve the value: either attached (already next to the flag) or the
    // next argv slot. If the flag does not take an argument, attachedValue
    // must be undefined.
    const takesArg = SHORT_WITH_ARG.has(letter);
    let value: string | undefined;
    if (takesArg) {
      if (attachedValue !== undefined) {
        value = attachedValue;
      } else {
        const v = needValue(flagDisplay);
        if (typeof v !== 'string') return v;
        value = v;
      }
    } else if (attachedValue !== undefined) {
      // A value was attached to a short flag that doesn't accept one. Treat
      // this as an invalid-option error (matches `getopt_long` behaviour
      // for clusters like `-Xy` where `X` doesn't take an argument — flex
      // continues to `y`; we keep it strict for clarity).
      return {
        kind: 'invalid-option',
        message: `option does not take an argument -- ${letter}`,
      };
    }

    switch (letter) {
      case 'a':
        args.echoAll = true;
        return null;
      case 'A':
        args.noAlign = true;
        return null;
      case 'b':
        args.echoErrors = true;
        return null;
      case 'C':
        // Since-PG17 "skip connection check" — no-op for our use.
        return null;
      case 'c':
        pushAction(actions, { kind: 'command', sql: value as string });
        return null;
      case 'd':
        applyDashD(args, value as string);
        return null;
      case 'e':
        args.echoQueries = true;
        return null;
      case 'E':
        args.echoHidden = 'on';
        return null;
      case 'f':
        pushAction(actions, { kind: 'file', path: value as string });
        return null;
      case 'F':
        args.fieldSep = value;
        args.fieldSepZero = false;
        return null;
      case 'h':
        args.host = value;
        return null;
      case 'H':
        args.htmlMode = true;
        return null;
      case 'l':
        args.list = true;
        return null;
      case 'L':
        args.log = value;
        return null;
      case 'n':
        args.noReadline = true;
        return null;
      case 'o':
        args.output = value;
        return null;
      case 'p': {
        const p = Number.parseInt(value as string, 10);
        if (!Number.isFinite(p) || p <= 0 || p > 65535) {
          return {
            kind: 'invalid-value',
            message: `invalid port number: "${value as string}"`,
          };
        }
        args.port = p;
        return null;
      }
      case 'P':
        pset.push(value as string);
        return null;
      case 'q':
        args.quiet = true;
        return null;
      case 'R':
        args.recordSep = value;
        args.recordSepZero = false;
        return null;
      case 's':
        args.singlestep = true;
        return null;
      case 'S':
        args.singleline = true;
        return null;
      case 't':
        args.tuplesOnly = true;
        return null;
      case 'T':
        // -T TEXT → push a synthetic pset directive so it routes through
        // the same `\pset tableattr` plumbing.
        pset.push(`tableattr=${value as string}`);
        return null;
      case 'U':
        args.user = value;
        return null;
      case 'v':
        pushVariable(variables, value as string);
        return null;
      case 'V':
        return {
          kind: 'version',
          message: VERSION_STRING,
        };
      case 'w':
        args.promptPassword = false;
        return null;
      case 'W':
        args.promptPassword = true;
        return null;
      case 'x':
        args.expanded = true;
        return null;
      case 'X':
        args.noPsqlrc = true;
        return null;
      case 'z':
        args.fieldSepZero = true;
        return null;
      case '0':
        args.recordSepZero = true;
        return null;
      case '1':
        args.singleTransaction = true;
        return null;
      case '?':
        return {
          kind: 'help',
          message: renderHelp(undefined),
        };
      default:
        return {
          kind: 'invalid-option',
          message: `invalid option -- ${letter}`,
        };
    }
  };

  // ---- Main loop. -------------------------------------------------------
  while (i < n) {
    const tok = argv[i];

    if (tok === '--') {
      // End of options. Everything after is positional.
      i += 1;
      while (i < n) {
        args.positional.push(argv[i]);
        i += 1;
      }
      break;
    }

    if (tok.startsWith('--')) {
      // Long option: `--name` or `--name=value`.
      const eq = tok.indexOf('=');
      const name = eq < 0 ? tok.slice(2) : tok.slice(2, eq);
      const attached = eq < 0 ? undefined : tok.slice(eq + 1);

      // Special-case the long-only synthetic options first.
      if (name === 'csv') {
        if (attached !== undefined) {
          return {
            kind: 'invalid-option',
            message: `option does not take an argument: --${name}`,
          };
        }
        args.csvOutput = true;
        i += 1;
        continue;
      }
      if (name === 'no-pager') {
        if (attached !== undefined) {
          return {
            kind: 'invalid-option',
            message: `option does not take an argument: --${name}`,
          };
        }
        args.noPager = true;
        i += 1;
        continue;
      }
      if (name === 'on-error-stop') {
        if (attached !== undefined) {
          return {
            kind: 'invalid-option',
            message: `option does not take an argument: --${name}`,
          };
        }
        args.onErrorStop = true;
        variables.push({ name: 'ON_ERROR_STOP', value: 'on' });
        i += 1;
        continue;
      }
      if (name === 'help') {
        const topic = attached;
        if (
          topic !== undefined &&
          topic !== 'options' &&
          topic !== 'commands' &&
          topic !== 'variables'
        ) {
          return {
            kind: 'invalid-option',
            message: `unrecognized help topic: ${topic}`,
          };
        }
        return { kind: 'help', message: renderHelp(topic) };
      }
      if (name === 'echo-hidden') {
        if (attached === undefined) {
          args.echoHidden = 'on';
        } else if (attached === 'noexec') {
          args.echoHidden = 'noexec';
        } else if (attached === '' || attached === 'on') {
          args.echoHidden = 'on';
        } else {
          return {
            kind: 'invalid-value',
            message: `invalid value for --echo-hidden: "${attached}"`,
          };
        }
        i += 1;
        continue;
      }

      const short = LONG_MAP[name];
      if (short === undefined) {
        return {
          kind: 'invalid-option',
          message: `unrecognized option: --${name}`,
        };
      }

      const requiresArg = LONG_WITH_ARG.has(name);
      const optionalArg = LONG_OPTIONAL_ARG.has(name);
      let value: string | undefined = attached;
      if (requiresArg && value === undefined) {
        if (i + 1 >= n) {
          return {
            kind: 'missing-arg',
            message: `option requires an argument: --${name}`,
          };
        }
        i += 1;
        value = argv[i];
      } else if (!requiresArg && !optionalArg && value !== undefined) {
        return {
          kind: 'invalid-option',
          message: `option does not take an argument: --${name}`,
        };
      }

      const err = applyShort(short, value, `--${name}`);
      if (err) return err;
      i += 1;
      continue;
    }

    if (tok.startsWith('-') && tok.length > 1) {
      // Short option cluster. Each char might consume the rest of the token
      // (or the next argv) as its value.
      let k = 1;
      while (k < tok.length) {
        const letter = tok[k];
        if (!SHORT_WITH_ARG.has(letter) && !SHORT_NO_ARG.has(letter)) {
          return {
            kind: 'invalid-option',
            message: `invalid option -- ${letter}`,
          };
        }
        if (SHORT_WITH_ARG.has(letter)) {
          // Consume the rest of this token as the value if anything remains,
          // otherwise pull from the next argv.
          const remainder = tok.slice(k + 1);
          const value = remainder.length > 0 ? remainder : undefined;
          const err = applyShort(letter, value, letter);
          if (err) return err;
          k = tok.length; // Consumed the rest.
          break;
        }
        const err = applyShort(letter, undefined, letter);
        if (err) return err;
        k += 1;
      }
      i += 1;
      continue;
    }

    // Positional.
    args.positional.push(tok);
    i += 1;
  }

  // Upstream consumes only DBNAME and USERNAME from positionals; extras are
  // warned about and ignored. We surface them all on `positional` so the
  // caller can warn/log; applyStartupArgs takes care of the first two.

  return {
    ...args,
    actions,
    variables,
    pset,
  };
};

// ---------------------------------------------------------------------------
// applyStartupArgs.
// ---------------------------------------------------------------------------

/**
 * Optional inputs to the vanilla-psql connection-lookup chain. When ANY of
 * these are supplied, `applyStartupArgs` switches from the legacy "base +
 * argv overrides" semantic to the full layered merge:
 *
 *   argv > URI partial (`uriPartial`) > env (`env`) > pgpass > service > libpq defaults
 *
 * Legacy callers (existing tests) pass `baseConnectOpts` only and skip
 * `resolution`; they get the same shape as before.
 *
 * Notes on the loading split:
 *   - pgpass and service files are async to load; doing it inside
 *     `applyStartupArgs` would force the function async. Instead, callers
 *     load them upstream and pass the parsed result in. The new flow in
 *     `runPsql` does exactly this; tests can build fixtures cheaply.
 *   - The `service name` decision (which entry to apply) is made here so the
 *     caller doesn't need to know whether `?service=…` came from the URI
 *     or `PGSERVICE` from env.
 */
export type ConnectResolution = {
  /** ConnectOptions fields explicitly set by the URI/conninfo. */
  uriPartial?: Partial<ConnectOptions>;
  /** Process env (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Parsed `.pgpass` entries (defaults to `[]`). */
  pgpassEntries?: readonly PgPassEntry[];
  /** Parsed `pg_service.conf` map (defaults to empty). */
  services?: ReadonlyMap<string, ServiceEntry>;
  /**
   * Explicit service-name override (e.g. from `?service=` in the URI). When
   * omitted, falls back to `$PGSERVICE`.
   */
  serviceName?: string;
};

export const applyStartupArgs = (
  args: ParsedArgs,
  settings: PsqlSettings,
  baseConnectOpts?: ConnectOptions,
  resolution?: ConnectResolution,
): { connect: ConnectOptions; preActions: readonly StartupAction[] } => {
  // -------- 1) Variable assignments. -------------------------------------
  for (const v of args.variables) {
    if (v.value === '') {
      // Mirror upstream `-v NAME` (no `=`): DeleteVariable.
      settings.vars.unset(v.name);
    } else {
      settings.vars.set(v.name, v.value);
    }
  }

  // -------- 2) Settings flags. -------------------------------------------
  if (args.echoAll) settings.vars.set('ECHO', 'all');
  if (args.echoErrors) settings.vars.set('ECHO', 'errors');
  if (args.echoQueries) settings.vars.set('ECHO', 'queries');
  if (args.echoHidden !== 'off') {
    settings.echoHidden = args.echoHidden;
    settings.vars.set(
      'ECHO_HIDDEN',
      args.echoHidden === 'noexec' ? 'noexec' : 'on',
    );
  }
  if (args.quiet) {
    settings.quiet = true;
    settings.vars.set('QUIET', 'on');
  }
  if (args.singleline) {
    settings.singleline = true;
    settings.vars.set('SINGLELINE', 'on');
  }
  if (args.singlestep) {
    settings.singlestep = true;
    settings.vars.set('SINGLESTEP', 'on');
  }
  if (args.onErrorStop) {
    settings.onErrorStop = true;
    settings.vars.set('ON_ERROR_STOP', 'on');
  }

  // -------- 3) Output formatting. ----------------------------------------
  if (args.noAlign) {
    settings.popt.topt.format = 'unaligned';
  }
  if (args.htmlMode) {
    settings.popt.topt.format = 'html';
  }
  if (args.csvOutput) {
    settings.popt.topt.format = 'csv';
  }
  if (args.tuplesOnly) {
    settings.popt.topt.tuplesOnly = true;
  }
  if (args.expanded) {
    settings.popt.topt.expanded = 'on';
  }
  if (args.fieldSepZero) {
    settings.popt.topt.fieldSep = '\0';
  } else if (args.fieldSep !== undefined) {
    settings.popt.topt.fieldSep = args.fieldSep;
  }
  if (args.recordSepZero) {
    settings.popt.topt.recordSep = '\0';
  } else if (args.recordSep !== undefined) {
    settings.popt.topt.recordSep = args.recordSep;
  }
  if (args.noPager) {
    settings.popt.topt.pager = 'off';
  }

  // -------- 4) pset directives. ------------------------------------------
  // We don't have a parsed `do_pset` here yet (lives in command/cmd_format),
  // so we surface them as raw strings and let the integration layer feed
  // them through once parsed. For tableattr (the most common -T use), apply
  // directly.
  for (const directive of args.pset) {
    const eq = directive.indexOf('=');
    if (eq >= 0) {
      const key = directive.slice(0, eq);
      const val = directive.slice(eq + 1);
      if (key === 'tableattr' || key === 'T') {
        settings.popt.topt.tableAttr = val.length > 0 ? val : null;
      } else if (key === 'pager') {
        if (val === 'on' || val === 'off' || val === 'always') {
          settings.popt.topt.pager = val;
        }
      }
      // Other directives left to the broader -P plumbing.
    }
  }

  // -------- 5) Connection overrides. -------------------------------------
  // Positional args follow upstream: positional[0] → dbname, positional[1] →
  // username (if not already set by a flag).
  let dbname = args.database;
  let username = args.user;
  if (args.positional[0] && !dbname) dbname = args.positional[0];
  if (args.positional[1] && !username) username = args.positional[1];

  // The argv flag layer mirrors the highest-priority CLI inputs (`-h`/`-p`
  // / positional DBNAME / etc). Only populated entries end up in the layer
  // so they don't accidentally clobber URI/env values.
  const argvLayer: Partial<ConnectOptions> = {};
  if (args.host !== undefined) argvLayer.host = args.host;
  if (args.port !== undefined) argvLayer.port = args.port;
  if (username !== undefined) argvLayer.user = username;
  if (dbname !== undefined) argvLayer.database = dbname;
  if (args.password !== undefined) argvLayer.password = args.password;
  if (args.replication !== undefined) argvLayer.replication = args.replication;

  // Two modes:
  //  - LEGACY: no `resolution` provided → behave exactly like before, with
  //    `baseConnectOpts` supplying every default and argv overriding it.
  //  - LAYERED: `resolution` provided → run the full vanilla-psql chain.
  let connect: ConnectOptions;
  if (resolution === undefined) {
    const base: ConnectOptions = baseConnectOpts ?? {
      host: 'localhost',
      port: 5432,
      user: '',
      database: '',
      ssl: 'prefer',
    };
    connect = { ...base, ...argvLayer };
  } else {
    connect = resolveLayeredConnect(argvLayer, resolution, baseConnectOpts);
  }

  return { connect, preActions: args.actions };
};

/**
 * Run the layered connection-parameter merge.
 *
 *   argv > URI partial > PG* env > .pgpass (password only) > service > libpq defaults
 *
 * `baseConnectOpts` (the legacy `ConnectOptions` argument) is treated as a
 * pre-baked URI partial when the resolution path is used WITHOUT an explicit
 * `uriPartial`. This keeps the door open for callers that still want to
 * pass a fully-defaulted URI shape from `parseConnectionUri`.
 */
const resolveLayeredConnect = (
  argvLayer: Partial<ConnectOptions>,
  resolution: ConnectResolution,
  legacyBase: ConnectOptions | undefined,
): ConnectOptions => {
  const env = resolution.env ?? {};
  const uriPartial =
    resolution.uriPartial ??
    (legacyBase !== undefined ? (legacyBase as Partial<ConnectOptions>) : {});

  // Pick the service entry: explicit `serviceName` argument first, else fall
  // back to `$PGSERVICE`. The URI parser threads `?service=` through to its
  // caller via this same field, so callers should populate `serviceName`
  // from there before invoking us.
  const serviceName = resolution.serviceName ?? env.PGSERVICE;
  let serviceEntry;
  if (serviceName !== undefined && serviceName !== '') {
    serviceEntry = resolution.services?.get(serviceName);
    if (serviceEntry === undefined) {
      // Mirror libpq: if the user explicitly named a service (via
      // `?service=`, conninfo `service=`, or `$PGSERVICE`) and it isn't
      // found in any loaded service file, fail fast with the exact
      // upstream wording. Without this the empty service layer would
      // silently degrade to a different connection target — surprising
      // and very hard to debug.
      throw new Error(`definition of service "${serviceName}" not found`);
    }
  }
  const serviceLayer: Partial<ConnectOptions> =
    serviceEntry !== undefined
      ? serviceEntryToConnectOptions(serviceEntry)
      : {};

  // Build the layer stack (highest priority first).
  const envLayer = envConnectionDefaults(env);
  const defaults = libpqConnectionDefaults(env);
  const layers: Partial<ConnectOptions>[] = [
    argvLayer,
    uriPartial,
    envLayer,
    serviceLayer,
  ];

  // First-pass merge (without pgpass) so we know what host/port/db/user
  // ended up as. pgpass is a password-only layer that depends on the
  // resolved target.
  let merged = mergeConnectOptions(layers, defaults);

  if (merged.password === undefined) {
    const pgpassPwd = lookupPgPass(resolution.pgpassEntries ?? [], {
      host: merged.host,
      port: merged.port,
      database: merged.database !== '' ? merged.database : merged.user,
      user: merged.user,
    });
    if (pgpassPwd !== undefined) {
      // Re-merge with pgpass slotted in just above libpq defaults so any
      // explicit `password=` in env / service still wins.
      const pgpassLayer: Partial<ConnectOptions> = { password: pgpassPwd };
      merged = mergeConnectOptions([...layers, pgpassLayer], defaults);
    }
  }

  return merged;
};

// ---------------------------------------------------------------------------
// Error-formatting helper for the integration layer.
// ---------------------------------------------------------------------------

export const formatParseError = (err: ParseError): string => err.message;
