import type { VarStore } from './variables.js';
import type { Connection } from './connection.js';
import type { PrintQueryOpts } from './printer.js';

export type VerbosityLevel = 'default' | 'verbose' | 'terse' | 'sqlstate';
export type ShowContext = 'never' | 'errors' | 'always';
export type EchoMode = 'none' | 'errors' | 'queries' | 'all';
export type EchoHidden = 'off' | 'on' | 'noexec';
export type OnErrorRollback = 'off' | 'on' | 'interactive';
export type CompCase = 'lower' | 'upper' | 'preserve-lower' | 'preserve-upper';
export type SendMode = 'extended-query' | 'extended-pipeline' | 'simple-query';
export type HistControl = 'none' | 'ignorespace' | 'ignoredups' | 'ignoreboth';

export type PsqlSettings = {
  db: Connection | null;
  vars: VarStore;
  popt: PrintQueryOpts;

  mainfile: string | null;
  inputfile: string | null;
  curCmdSource: 'stdin' | 'file' | 'option' | 'rcfile';

  /**
   * `\restrict` key, or `null` when not in restricted mode. Held here —
   * NOT in the user-writable `vars` store — so that `\set`/`\unset`/
   * `\getenv`/`\gset` of a variable named `RESTRICTED` cannot escape
   * restricted mode (review item #12). Only `\restrict` / `\unrestrict`
   * mutate it.
   */
  restrictedKey: string | null;

  prompt1: string;
  prompt2: string;
  prompt3: string;

  notty: boolean;
  quiet: boolean;
  singleline: boolean;
  singlestep: boolean;
  onErrorStop: boolean;
  fetchCount: number;
  verbosity: VerbosityLevel;
  showContext: ShowContext;
  echo: EchoMode;
  echoHidden: EchoHidden;
  onErrorRollback: OnErrorRollback;
  compCase: CompCase;
  sendMode: SendMode;
  histControl: HistControl;
  hideCompression: boolean;
  hideTableam: boolean;

  logfile: NodeJS.WritableStream | null;
  timing: boolean;
  lastErrorResult: LastErrorResult | null;
  /**
   * The most recent SQL string our impl actually shipped to the server via
   * `execSimple` / cursor / extended-pipeline. Upstream tracks this in
   * `pset.last_query` (called from `SendQuery`) so `\g` / `\gx` invoked with
   * an empty buffer re-run the prior query. Captured at the start of each
   * dispatch in `sendQuery`; cleared by `\r` (reset_query_state — not yet
   * wired). Empty string means "no prior query yet" — `\g` then no-ops.
   */
  lastQuery: string;
};

/**
 * Mirrors the named fields of an ErrorResponse message (pg-protocol's
 * `DatabaseError` shape) plus the originating SQL text. Captured when a
 * query fails so `\errverbose` can re-render the error in VERBOSE form,
 * including LINE / `^` pointer / LOCATION metadata. `sqlstate` is kept
 * as a legacy alias for `code` — older callers (and one unit test) read
 * `lastErrorResult.sqlstate` directly.
 */
export type LastErrorResult = {
  /** Server severity (`S` field — e.g. ERROR, FATAL). */
  severity?: string;
  /** SQLSTATE code (`C` field, 5 chars). */
  code?: string;
  /** Legacy alias for `code` retained for backward compatibility. */
  sqlstate?: string;
  /** Primary message (`M` field). */
  message?: string;
  /** Optional detail line (`D` field). */
  detail?: string;
  /** Optional hint line (`H` field). */
  hint?: string;
  /** 1-based character position in the user's query (`P` field). */
  position?: string;
  /** Position inside an internally generated query (`p` field). */
  internalPosition?: string;
  /** Server-generated query text (`q` field). */
  internalQuery?: string;
  /** Where-context string (`W` field). */
  where?: string;
  schema?: string;
  table?: string;
  column?: string;
  dataType?: string;
  constraint?: string;
  /** Source file in the server (`F` field). */
  file?: string;
  /** Source line in the server (`L` field). */
  line?: string;
  /** Server routine name (`R` field). */
  routine?: string;
  /** The originating SQL text — used to render the `LINE N: ...` re-print. */
  sqlText?: string;
};
