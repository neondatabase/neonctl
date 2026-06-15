import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { getRequestListener } from '@hono/node-server';

import {
  portSelectionFromEnv,
  resolveFetchHandler,
  withErrorBoundary,
  type FetchHandler,
} from './runtime.js';

describe('resolveFetchHandler', () => {
  it('picks `export default { fetch }`', async () => {
    const response = new Response('from fetch object');
    const handler = resolveFetchHandler({
      default: { fetch: () => response },
    });
    const result = await handler(new Request('http://localhost/'));
    expect(result).toBe(response);
  });

  it('picks `export default function`', async () => {
    const response = new Response('from default function');
    const handler = resolveFetchHandler({
      default: () => response,
    });
    const result = await handler(new Request('http://localhost/'));
    expect(result).toBe(response);
  });

  it('throws a helpful error when no handler is present', () => {
    expect(() => resolveFetchHandler({})).toThrow(/No request handler found/);
  });

  it('throws when only a named `handler` export exists (named handler is not supported)', () => {
    expect(() =>
      resolveFetchHandler({ handler: () => new Response('named') }),
    ).toThrow(/No request handler found/);
  });
});

describe('withErrorBoundary', () => {
  it('turns a thrown error into a 500 whose body contains the message', async () => {
    const boundary = withErrorBoundary(() => {
      throw new Error('boom from the user handler');
    });
    const res = await boundary(new Request('http://localhost/'));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('boom from the user handler');
  });

  it('passes a successful response through unchanged', async () => {
    const ok = new Response('all good', { status: 201 });
    const boundary = withErrorBoundary(() => ok);
    const res = await boundary(new Request('http://localhost/'));
    expect(res).toBe(ok);
    expect(res.status).toBe(201);
  });
});

describe('portSelectionFromEnv', () => {
  it('returns an explicit selection when NEON_DEV_PORT is set', () => {
    expect(portSelectionFromEnv({ NEON_DEV_PORT: '3000' })).toEqual({
      mode: 'explicit',
      port: 3000,
    });
  });

  it('searches from the default base when NEON_DEV_PORT is empty', () => {
    expect(portSelectionFromEnv({ NEON_DEV_PORT: '' })).toEqual({
      mode: 'search',
      from: 8787,
    });
  });

  it('searches from the default base when NEON_DEV_PORT is unset', () => {
    expect(portSelectionFromEnv({})).toEqual({ mode: 'search', from: 8787 });
  });

  it('respects NEON_DEV_PORT_BASE when searching', () => {
    expect(portSelectionFromEnv({ NEON_DEV_PORT_BASE: '4000' })).toEqual({
      mode: 'search',
      from: 4000,
    });
  });

  it('throws on an invalid NEON_DEV_PORT', () => {
    expect(() => portSelectionFromEnv({ NEON_DEV_PORT: 'not-a-port' })).toThrow(
      /Invalid NEON_DEV_PORT/,
    );
  });

  it('binds an injected PORT (e.g. PORT=3000) when NEON_DEV_PORT is unset', () => {
    expect(portSelectionFromEnv({ PORT: '4123' })).toEqual({
      mode: 'explicit',
      port: 4123,
    });
  });

  it('prefers NEON_DEV_PORT over PORT', () => {
    expect(
      portSelectionFromEnv({ NEON_DEV_PORT: '3000', PORT: '4123' }),
    ).toEqual({ mode: 'explicit', port: 3000 });
  });

  it('throws on an invalid PORT', () => {
    expect(() => portSelectionFromEnv({ PORT: 'nope' })).toThrow(
      /Invalid PORT/,
    );
  });
});

describe('getRequestListener round-trip', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      const toClose = server;
      server = null;
      await new Promise<void>((resolve, reject) => {
        toClose.close((err) => {
          if (err) reject(err instanceof Error ? err : new Error(String(err)));
          else resolve();
        });
      });
    }
  });

  const start = async (handler: FetchHandler): Promise<number> => {
    const listener = getRequestListener(handler);
    const created = createServer((incoming, outgoing) => {
      void listener(incoming, outgoing);
    });
    server = created;
    return new Promise<number>((resolve, reject) => {
      created.once('error', reject);
      created.listen(0, () => {
        resolve((created.address() as AddressInfo).port);
      });
    });
  };

  it('round-trips a request through the runtime helpers', async () => {
    const handler = withErrorBoundary(
      resolveFetchHandler({
        default: {
          fetch: (req: Request) =>
            new Response(`hello from ${new URL(req.url).pathname}`, {
              status: 200,
              headers: { 'x-neon-dev': 'runtime' },
            }),
        },
      }),
    );

    const port = await start(handler);
    const res = await fetch(`http://127.0.0.1:${port}/greet`);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-neon-dev')).toBe('runtime');
    await expect(res.text()).resolves.toBe('hello from /greet');
  });
});
