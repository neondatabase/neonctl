import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { type AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  apiErrorBodyCode,
  apiErrorMessage,
  apiErrorRequestId,
  HttpError,
  httpFetch,
  isApiError,
  streamToWeb,
} from './http.js';

// ---------------------------------------------------------------------------
// isApiError: the axios-free replacement for axios' `isAxiosError`. It must
// detect both our own HttpError and the api-client's axios errors (recognised
// structurally via the `isAxiosError` marker), and nothing else.
// ---------------------------------------------------------------------------
describe('isApiError', () => {
  it('detects HttpError', () => {
    expect(isApiError(new HttpError('boom'))).toBe(true);
  });

  it('detects an axios-shaped error via its isAxiosError marker', () => {
    // This is exactly what `@neondatabase/api-client` throws: a plain Error
    // carrying `isAxiosError === true` (from its own bundled axios copy).
    const axiosLike = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { status: 404 },
    });
    expect(isApiError(axiosLike)).toBe(true);
  });

  it('rejects a plain Error and non-error values', () => {
    expect(isApiError(new Error('plain'))).toBe(false);
    expect(isApiError({ isAxiosError: false })).toBe(false);
    expect(isApiError({})).toBe(false);
    expect(isApiError(null)).toBe(false);
    expect(isApiError(undefined)).toBe(false);
    expect(isApiError('Request failed with status code 500')).toBe(false);
    expect(isApiError(500)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Accessors: pull values out of the (untyped) error body / headers safely,
// without leaking `any` to call sites.
// ---------------------------------------------------------------------------
describe('error accessors', () => {
  const withBody = (data: unknown, headers: Record<string, unknown> = {}) =>
    new HttpError('Request failed with status code 400', {
      response: { status: 400, statusText: 'Bad Request', data, headers },
    });

  it('reads a non-empty server message', () => {
    expect(apiErrorMessage(withBody({ message: 'org_id is required' }))).toBe(
      'org_id is required',
    );
  });

  it('ignores empty, non-string, or absent messages', () => {
    expect(apiErrorMessage(withBody({ message: '' }))).toBeUndefined();
    expect(apiErrorMessage(withBody({ message: 42 }))).toBeUndefined();
    expect(apiErrorMessage(withBody({}))).toBeUndefined();
    expect(apiErrorMessage(withBody('a plain string body'))).toBeUndefined();
    expect(apiErrorMessage(withBody(undefined))).toBeUndefined();
    expect(apiErrorMessage(new HttpError('no response'))).toBeUndefined();
  });

  it('reads a server error code', () => {
    expect(
      apiErrorBodyCode(withBody({ code: 'INVALID_SHARED_OAUTH_PROVIDER' })),
    ).toBe('INVALID_SHARED_OAUTH_PROVIDER');
    expect(apiErrorBodyCode(withBody({ code: 7 }))).toBeUndefined();
    expect(apiErrorBodyCode(withBody({}))).toBeUndefined();
  });

  it('reads the Neon request id header', () => {
    expect(
      apiErrorRequestId(
        withBody({}, { 'x-neon-ret-request-id': 'req-abc-123' }),
      ),
    ).toBe('req-abc-123');
    expect(apiErrorRequestId(withBody({}, {}))).toBeUndefined();
    expect(apiErrorRequestId(new HttpError('no response'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// streamToWeb: a Node Readable adapted to a web ReadableStream usable as a
// fetch body, without buffering the whole source.
// ---------------------------------------------------------------------------
describe('streamToWeb', () => {
  it('streams Buffer chunks through unchanged', async () => {
    const web = streamToWeb(
      Readable.from([Buffer.from('hello '), Buffer.from('world')]),
    );
    expect(await new Response(web).text()).toBe('hello world');
  });

  it('encodes string chunks as UTF-8', async () => {
    const web = streamToWeb(Readable.from(['über', '-', 'café']));
    expect(await new Response(web).text()).toBe('über-café');
  });

  it('propagates source errors to the consumer', async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error('disk gone'));
      },
    });
    await expect(new Response(streamToWeb(failing)).text()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// httpFetch: a real local server stands in for the remote host so the whole
// request/response/error path runs end to end with no mocking.
// ---------------------------------------------------------------------------
describe('httpFetch', () => {
  let server: Server;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  let baseUrl: string;

  beforeEach(async () => {
    handler = (_req, res) => res.end('ok');
    server = createServer((req, res) => {
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }),
    );
  });

  it('returns the Response for a 2xx and reads the body as text', async () => {
    handler = (_req, res) => {
      res.statusCode = 200;
      res.end('the body');
    };
    const res = await httpFetch(`${baseUrl}/ok`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('the body');
  });

  it('reads a binary body via arrayBuffer', async () => {
    handler = (_req, res) => {
      res.statusCode = 200;
      res.end(Buffer.from([1, 2, 3, 4]));
    };
    const res = await httpFetch(`${baseUrl}/bin`);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });

  it('forwards request method and headers', async () => {
    let seen: { method?: string; auth?: string } = {};
    handler = (req, res) => {
      seen = { method: req.method, auth: req.headers.authorization };
      res.end('ok');
    };
    await httpFetch(`${baseUrl}/x`, {
      method: 'GET',
      headers: { Authorization: 'Bearer t0ken' },
    });
    expect(seen.method).toBe('GET');
    expect(seen.auth).toBe('Bearer t0ken');
  });

  it('throws an HttpError carrying status, message and parsed JSON body on non-2xx', async () => {
    handler = (_req, res) => {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-neon-ret-request-id', 'req-xyz');
      res.end(JSON.stringify({ message: 'Not Found' }));
    };
    const err = await httpFetch(`${baseUrl}/missing`).catch((e: unknown) => e);
    expect(isApiError(err)).toBe(true);
    if (!(err instanceof HttpError)) {
      throw new Error('expected HttpError');
    }
    // Message mirrors axios so interpolated user-facing strings are unchanged.
    expect(err.message).toBe('Request failed with status code 404');
    expect(err.response?.status).toBe(404);
    expect(apiErrorMessage(err)).toBe('Not Found');
    expect(apiErrorRequestId(err)).toBe('req-xyz');
  });

  it('keeps a non-JSON error body as a raw string', async () => {
    handler = (_req, res) => {
      res.statusCode = 403;
      res.setHeader('content-type', 'text/plain');
      res.end('Forbidden');
    };
    const err = await httpFetch(`${baseUrl}/forbidden`).catch(
      (e: unknown) => e,
    );
    if (!(err instanceof HttpError)) {
      throw new Error('expected HttpError');
    }
    expect(err.response?.status).toBe(403);
    expect(err.response?.data).toBe('Forbidden');
    // No JSON message to surface.
    expect(apiErrorMessage(err)).toBeUndefined();
  });

  it('times out with an ECONNABORTED code, mirroring axios', async () => {
    handler = (_req, res) => {
      // Respond well after the deadline; clean up if the client aborts first.
      const timer = setTimeout(() => {
        if (!res.writableEnded) {
          res.end('late');
        }
      }, 1000);
      res.on('close', () => {
        clearTimeout(timer);
      });
    };
    const err = await httpFetch(`${baseUrl}/slow`, { timeoutMs: 50 }).catch(
      (e: unknown) => e,
    );
    if (!(err instanceof HttpError)) {
      throw new Error('expected HttpError');
    }
    expect(err.code).toBe('ECONNABORTED');
    expect(err.message).toContain('timeout of 50ms');
  });

  it('does not follow redirects (redirect: error) so request bodies are never resent', async () => {
    handler = (_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', '/elsewhere');
      res.end();
    };
    const err = await httpFetch(`${baseUrl}/redirect`, {
      redirect: 'error',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // A redirect refusal is a transport failure, not an API error with a status.
    expect(isApiError(err)).toBe(false);
  });

  it('streams a request body with a manual Content-Length (not chunked)', async () => {
    let captured: {
      body?: string;
      contentLength?: string;
      transferEncoding?: string;
      contentType?: string;
    } = {};
    handler = (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
      req.on('end', () => {
        captured = {
          body: Buffer.concat(chunks).toString('utf8'),
          contentLength: req.headers['content-length'],
          transferEncoding: req.headers['transfer-encoding'],
          contentType: req.headers['content-type'],
        };
        res.statusCode = 200;
        res.end();
      });
    };

    const payload = 'streamed upload body';
    await httpFetch(`${baseUrl}/upload`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/plain',
        'Content-Length': String(Buffer.byteLength(payload)),
      },
      body: streamToWeb(Readable.from([Buffer.from(payload)])),
      duplex: 'half',
    });

    expect(captured.body).toBe(payload);
    expect(captured.contentType).toBe('text/plain');
    expect(captured.contentLength).toBe(String(Buffer.byteLength(payload)));
    // The explicit Content-Length must win: the upload is sent framed, not
    // chunked (the object-storage data plane requires a length).
    expect(captured.transferEncoding).toBeUndefined();
  });
});
