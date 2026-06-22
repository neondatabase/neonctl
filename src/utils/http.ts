// HTTP + API error handling for neonctl, free of any direct axios dependency.
//
// neonctl no longer depends on axios. Two concerns used to rely on it, and both
// are handled here:
//
//  1. Error detection. The generated Neon API client
//     (`@neondatabase/api-client`) still uses axios under the hood and rejects
//     with `AxiosError` instances on non-2xx responses. Rather than import axios
//     just for `isAxiosError`, this module detects those errors structurally via
//     the `isAxiosError` marker the client sets, and exposes a small, stable,
//     axios-free surface (`ApiError` + accessors) that the rest of the CLI uses.
//
//  2. Direct requests. The handful of calls neonctl makes itself (GitHub
//     template downloads, the presigned object-storage upload) go through
//     {@link httpFetch}, a thin wrapper over the global `fetch` that mirrors the
//     parts of axios those call sites depended on: it throws on non-2xx (like
//     axios' default `validateStatus`) with the parsed body attached, supports a
//     request timeout (surfaced with axios' `ECONNABORTED` code), and logs
//     request/response lines under DEBUG (replacing axios-debug-log, which only
//     ever instrumented these direct calls). Errors thrown here are
//     {@link HttpError}, which implements the same `ApiError` surface, so callers
//     branch on `.response?.status` uniformly regardless of origin.
//
// If the api-client ever drops axios, this file is the only place that needs to
// change.

import { type Readable } from 'node:stream';

import { log } from '../log.js';

/** The response portion of a normalized API/HTTP error. */
export type ApiErrorResponse = {
  /** HTTP status code (always present when a response was received). */
  status: number;
  /** HTTP status text (may be empty). */
  statusText: string;
  /** Parsed response body (JSON object/array, raw string, or a stream). */
  data?: unknown;
  /** Lower-cased response headers. */
  headers: Record<string, unknown>;
};

/**
 * A normalized HTTP/API error: the axios-free shape neonctl relies on. Both the
 * api-client's `AxiosError` (detected structurally) and {@link HttpError} (our
 * own `fetch` failures) satisfy this type, so call sites handle them the same
 * way.
 */
export type ApiError = Error & {
  /** Transport-level error code, e.g. `ECONNABORTED` for a timeout. */
  code?: string;
  response?: ApiErrorResponse;
  request?: { path?: string };
};

/**
 * Error thrown by {@link httpFetch} for a non-2xx response or a timeout. The
 * message mirrors axios (`Request failed with status code <n>`) so user-facing
 * messages that interpolate it are unchanged after the migration.
 */
export class HttpError extends Error implements ApiError {
  readonly code?: string;
  readonly response?: ApiErrorResponse;
  readonly request?: { path?: string };

  constructor(
    message: string,
    init: {
      code?: string;
      response?: ApiErrorResponse;
      request?: { path?: string };
    } = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.code = init.code;
    this.response = init.response;
    this.request = init.request;
  }
}

// axios marks every error it throws with `isAxiosError === true`. The check is
// instance-agnostic (it's a plain property), which is exactly why neonctl's old
// `isAxiosError` could detect errors from the api-client's bundled axios copy —
// and why this structural check is a faithful, dependency-free replacement.
const hasAxiosErrorMarker = (err: object): boolean =>
  'isAxiosError' in err && err.isAxiosError === true;

/**
 * Type guard for a normalized API/HTTP error. True for {@link HttpError} and for
 * any error carrying axios' `isAxiosError` marker (i.e. thrown by the
 * api-client). The drop-in replacement for axios' `isAxiosError`.
 */
export const isApiError = (err: unknown): err is ApiError => {
  if (err instanceof HttpError) {
    return true;
  }
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  return hasAxiosErrorMarker(err);
};

/** The parsed JSON body of an error, when it is a non-null object. */
const errorBody = (err: ApiError): object | undefined => {
  const data = err.response?.data;
  return typeof data === 'object' && data !== null ? data : undefined;
};

/**
 * The server-provided `message` from an API error body, when present and a
 * non-empty string. Mirrors how the Neon console reports errors as
 * `{ "message": "..." }`.
 */
export const apiErrorMessage = (err: ApiError): string | undefined => {
  const body = errorBody(err);
  if (body && 'message' in body) {
    const message = body.message;
    if (typeof message === 'string' && message !== '') {
      return message;
    }
  }
  return undefined;
};

/**
 * The server-provided `code` from an API error body, when present and a string
 * (e.g. `INVALID_SHARED_OAUTH_PROVIDER`).
 */
export const apiErrorBodyCode = (err: ApiError): string | undefined => {
  const body = errorBody(err);
  if (body && 'code' in body) {
    const code = body.code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return undefined;
};

/** The Neon request-id response header, used to correlate failed requests. */
export const apiErrorRequestId = (err: ApiError): string | undefined => {
  const value = err.response?.headers['x-neon-ret-request-id'];
  return typeof value === 'string' ? value : undefined;
};

// Mirrors axios' timeout error code so existing timeout handling (which keys off
// `err.code === 'ECONNABORTED'`) keeps working for both api-client and direct
// requests.
const TIMEOUT_CODE = 'ECONNABORTED';

export type HttpFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  /** Required by the runtime when streaming a request body. */
  duplex?: 'half';
  /** Redirect handling. Defaults to the platform default ('follow'). */
  redirect?: RequestRedirect;
  /** Abort the request after this many milliseconds (axios `timeout`). */
  timeoutMs?: number;
};

/**
 * Adapt a Node `Readable` into a web `ReadableStream` usable as a `fetch`
 * request body. We construct the global `ReadableStream` directly (rather than
 * `Readable.toWeb`, whose `node:stream/web` return type is not assignable to the
 * `BodyInit` `fetch` expects) so no cross-stream-type cast is needed and it
 * works on Node 18+. Pull-based, so it preserves streaming/backpressure and
 * never buffers the whole source in memory.
 */
export const streamToWeb = (readable: Readable): ReadableStream<Uint8Array> => {
  const iterator = readable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
          return;
        }
        const chunk: unknown = value;
        if (chunk instanceof Uint8Array) {
          controller.enqueue(chunk);
        } else if (typeof chunk === 'string') {
          controller.enqueue(new TextEncoder().encode(chunk));
        } else {
          controller.error(
            new Error(
              'Unexpected non-binary chunk while streaming request body',
            ),
          );
        }
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      // Propagate consumer cancellation upstream so the file handle is released.
      if (typeof iterator.return === 'function') {
        await iterator.return(reason);
      }
    },
  });
};

const collectHeaders = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

const toHttpError = async (res: Response, url: string): Promise<HttpError> => {
  let data: unknown;
  try {
    const text = await res.text();
    if (text !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
  } catch {
    // Body already consumed or unreadable; status alone is enough to branch on.
  }
  return new HttpError(`Request failed with status code ${res.status}`, {
    response: {
      status: res.status,
      statusText: res.statusText,
      data,
      headers: collectHeaders(res.headers),
    },
    request: { path: url },
  });
};

/**
 * `fetch` with axios-like ergonomics for neonctl's direct requests. Resolves to
 * the `Response` (the caller reads `.text()` / `.arrayBuffer()` / `.body`) and
 * throws {@link HttpError} on a non-2xx response or a timeout.
 */
export const httpFetch = async (
  url: string,
  options: HttpFetchOptions = {},
): Promise<Response> => {
  const { timeoutMs, method, headers, body, duplex, redirect } = options;

  const controller =
    timeoutMs !== undefined ? new AbortController() : undefined;
  const timer =
    controller !== undefined && timeoutMs !== undefined
      ? setTimeout(() => {
          controller.abort();
        }, timeoutMs)
      : undefined;

  log.debug('%s %s', (method ?? 'GET').toUpperCase(), url);

  let res: Response;
  try {
    res = await fetch(url, {
      ...(method !== undefined ? { method } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(duplex !== undefined ? { duplex } : {}),
      ...(redirect !== undefined ? { redirect } : {}),
      ...(controller !== undefined ? { signal: controller.signal } : {}),
    });
  } catch (err) {
    if (controller?.signal.aborted) {
      throw new HttpError(`timeout of ${timeoutMs}ms exceeded`, {
        code: TIMEOUT_CODE,
        request: { path: url },
      });
    }
    throw err;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  log.debug('%d %s', res.status, res.statusText);

  if (!res.ok) {
    throw await toHttpError(res, url);
  }
  return res;
};
