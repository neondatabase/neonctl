import type { PsqlSettings } from './settings.js';
import type { BackslashRegistry } from './backslash.js';

export type IfState =
  | 'none'
  | 'true'
  | 'false'
  | 'else-true'
  | 'else-false'
  | 'ignored';

export type CondStackFrame = {
  state: IfState;
  branchTaken: boolean;
};

export type CondStack = {
  push(initial: IfState): void;
  pop(): CondStackFrame | undefined;
  top(): CondStackFrame | undefined;
  isActive(): boolean;
  setState(state: IfState): void;
  depth(): number;
};

export type REPLContext = {
  settings: PsqlSettings;
  registry: BackslashRegistry;
  cond: CondStack;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export type Stdio = {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
};
