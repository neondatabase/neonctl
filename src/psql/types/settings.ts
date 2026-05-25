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
  lastErrorResult: { sqlstate?: string; message?: string } | null;
};
