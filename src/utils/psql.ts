import { log } from '../log.js';
import { spawn } from 'child_process';
import which from 'which';

export type PsqlMode = 'native' | 'ts' | 'auto';

export type PsqlOpts = {
  mode?: PsqlMode;
};

const resolveMode = (opts: PsqlOpts): PsqlMode => {
  if (opts.mode && opts.mode !== 'auto') return opts.mode;
  if (process.env.NEONCTL_PSQL_FALLBACK === '1') return 'ts';
  return opts.mode ?? 'auto';
};

const execNative = async (
  binary: string,
  connection_uri: string,
  args: string[],
): Promise<never> => {
  log.info('Connecting to the database using psql...');
  const child = spawn(binary, [connection_uri, ...args], {
    stdio: 'inherit',
  });

  for (const signame of ['SIGINT', 'SIGTERM']) {
    process.on(signame, (code) => {
      if (!child.killed && code !== null) {
        child.kill(code as NodeJS.Signals);
      }
    });
  }

  return new Promise<never>((_, reject) => {
    child.on('exit', (code: number | null) => {
      process.exit(code === null ? 1 : code);
    });
    child.on('error', reject);
  });
};

const execTs = async (
  connection_uri: string,
  args: string[],
): Promise<never> => {
  log.info('Connecting to the database using embedded psql (TypeScript)...');
  const { runPsql } = await import('../psql/index.js');
  const code = await runPsql([connection_uri, ...args], {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exit(code);
};

export const psql = async (
  connection_uri: string,
  args: string[] = [],
  opts: PsqlOpts = {},
): Promise<never> => {
  const mode = resolveMode(opts);

  if (mode === 'ts') {
    return execTs(connection_uri, args);
  }

  const nativePath = await which('psql', { nothrow: true });

  if (mode === 'native') {
    if (nativePath === null) {
      log.error(`psql is not available in the PATH`);
      process.exit(1);
    }
    return execNative(nativePath, connection_uri, args);
  }

  // 'auto': strict fallback — prefer native; only TS if missing.
  if (nativePath !== null) {
    return execNative(nativePath, connection_uri, args);
  }

  log.info(
    'psql binary not found on PATH; falling back to embedded TypeScript psql',
  );
  return execTs(connection_uri, args);
};
