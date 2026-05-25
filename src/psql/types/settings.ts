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
