import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { getRequestListener } from '@hono/node-server';

/**
 * A WHATWG fetch-style handler: takes a Request, returns a Response. The single
 * shape the local dev server and the deployed Neon Functions runtime both speak.
 */
export type FetchHandler = (req: Request) => Response | Promise<Response>;

type UserModule = Record<string, unknown>;

const isFunction = (value: unknown): value is FetchHandler =>
  typeof value === 'function';

const hasFetchMethod = (
  value: unknown,
): value is { fetch: (req: Request) => Response | Promise<Response> } =>
  typeof value === 'object' &&
  value !== null &&
  'fetch' in value &&
  typeof (value as { fetch: unknown }).fetch === 'function';

/**
 * Resolve the user's exported handler to a single fetch callback.
 *
 * Resolution order (first match wins):
 *   1. `export default { fetch }`      — Workers / Neon Functions style
 *   2. `export default function (req)` — bare (async) default function
 */
export const resolveFetchHandler = (mod: UserModule): FetchHandler => {
  const defaultExport = mod.default;

  if (hasFetchMethod(defaultExport)) {
    const target = defaultExport;
    return (req) => target.fetch(req);
  }

  if (isFunction(defaultExport)) {
    return defaultExport;
  }

  throw new Error(
    'No request handler found in the source module. Export one of:\n' +
      '  export default { fetch(req) { /* ... */ } }\n' +
      '  export default function (req) { /* ... */ }',
  );
};

/**
 * Wrap a fetch handler so user errors become a 500 response (with the message
 * in the body during dev) instead of crashing the child process.
 */
export const withErrorBoundary = (handler: FetchHandler): FetchHandler => {
  return async (req) => {
    try {
      return await handler(req);
    } catch (err) {
      const message =
        err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`Request handler threw an error:\n${message}\n`);
      return new Response(`Internal Server Error\n\n${message}`, {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  };
};

/**
 * How the runtime picks its port:
 *   - `explicit`: bind this exact port and crash on conflict (an explicit choice
 *     — `--port` or portless's `PORT` — that is taken is an error).
 *   - `search`: walk upward from `from` until a free port is found; never crash.
 */
export type PortSelection =
  | { mode: 'explicit'; port: number }
  | { mode: 'search'; from: number };

export type StartRuntimeOptions = {
  source: string;
  port: PortSelection;
  hostname?: string;
};

const isAddressInUse = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  (err as { code?: unknown }).code === 'EADDRINUSE';

const DEFAULT_SEARCH_BASE = 8787;
const MAX_SEARCH_STEPS = 100;

const bindPort = async (
  server: Server,
  selection: PortSelection,
  hostname: string | undefined,
): Promise<number> => {
  if (selection.mode === 'explicit') {
    return listen(server, selection.port, hostname);
  }
  for (let step = 0; step < MAX_SEARCH_STEPS; step++) {
    try {
      return await listen(server, selection.from + step, hostname);
    } catch (err) {
      if (!isAddressInUse(err)) throw err;
    }
  }
  throw new Error(
    `Could not find a free port in ${selection.from}-${
      selection.from + MAX_SEARCH_STEPS - 1
    }`,
  );
};

const listen = (
  server: Server,
  port: number,
  hostname?: string,
): Promise<number> =>
  new Promise<number>((resolveListen, rejectListen) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      rejectListen(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolveListen((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, hostname);
  });

/**
 * Load the (already-bundled) user module, build the listener, and start an HTTP
 * server. Announces the bound port on stdout as `neon-dev:ready <port>` so the
 * parent can render the URL. Resolves with the bound port.
 */
export const startRuntime = async ({
  source,
  port,
  hostname,
}: StartRuntimeOptions): Promise<number> => {
  const absoluteSource = resolve(process.cwd(), source);
  const mod = (await import(pathToFileURL(absoluteSource).href)) as UserModule;
  const handler = withErrorBoundary(resolveFetchHandler(mod));

  const listener = getRequestListener(handler, { hostname });
  const server = createServer((incoming, outgoing) => {
    void listener(incoming, outgoing);
  });

  const boundPort = await bindPort(server, port, hostname);
  process.stdout.write(`neon-dev:ready ${boundPort}\n`);
  return boundPort;
};

/**
 * Build a {@link PortSelection} from the environment:
 *   - `NEON_DEV_PORT` set -> explicit bind (crash if taken)
 *   - otherwise           -> search upward from `NEON_DEV_PORT_BASE` (or default)
 */
export const portSelectionFromEnv = (env: NodeJS.ProcessEnv): PortSelection => {
  const explicit = env.NEON_DEV_PORT;
  if (explicit !== undefined && explicit !== '') {
    const port = Number(explicit);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`Invalid NEON_DEV_PORT: "${explicit}"`);
    }
    return { mode: 'explicit', port };
  }
  const base = Number(env.NEON_DEV_PORT_BASE ?? DEFAULT_SEARCH_BASE);
  return {
    mode: 'search',
    from: Number.isInteger(base) ? base : DEFAULT_SEARCH_BASE,
  };
};

const isDirectExecution = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
};

if (isDirectExecution()) {
  const source = process.env.NEON_DEV_SOURCE ?? process.argv[2];
  if (!source) {
    process.stderr.write('neon-dev runtime: missing source path\n');
    process.exit(1);
  }
  startRuntime({ source, port: portSelectionFromEnv(process.env) }).catch(
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`neon-dev runtime failed to start: ${msg}\n`);
      process.exit(1);
    },
  );
}
