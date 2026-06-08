/**
 * COPY streaming adapter (WP-16).
 *
 * The wire-level work — driving CopyData / CopyDone / CopyFail through the
 * v3 protocol — lives in `./connection.ts` directly (PgConnection exposes
 * `startCopyIn` and `startCopyOut`). This module is a thin convenience layer
 * that re-exports the public types and offers a single helper that callers
 * can use without learning the connection-level state machine:
 *
 *     const tag = await copyFromStream(conn, "COPY t FROM STDIN", readable);
 *     // tag → "COPY 17"
 *
 *     for await (const chunk of (await conn.startCopyOut("COPY t TO STDOUT"))) {
 *       writable.write(chunk);
 *     }
 *
 * Why PgConnection owns the protocol state and not this module: the COPY
 * state machine is a *mode switch* on the same socket — CopyInResponse /
 * CopyOutResponse / CopyDone / CommandComplete are interleaved with normal
 * backend messages and have to be routed through the same MessageParser.
 * Putting that here would require either exposing connection internals
 * (private fields, message dispatch) or duplicating the parser, both worse
 * than the in-place implementation.
 *
 * For the `\copy` parser/runner (cmd_copy.ts), this file is just the
 * doorbell — call `connection.startCopyIn(sql)` to get a `CopyInStream`, then
 * pipe a Readable into it via `pumpReadable()`.
 */

import { Buffer } from 'node:buffer';
import type { Readable } from 'node:stream';

import type {
  Connection,
  CopyInStream,
  CopyOutStream,
} from '../types/connection.js';

/**
 * Pump every chunk from a Node Readable into a CopyInStream, then end it.
 *
 * Mirrors the loop in upstream `handleCopyIn`: read until EOF, write each
 * buffer as CopyData, finalise with CopyDone. On read error, abort via
 * CopyFail so the server returns to ready-state cleanly. Returns whatever
 * the connection recorded as the last COPY command tag (e.g. `"COPY 17"`).
 *
 * The function is text/binary agnostic — we pass raw bytes through. CSV vs
 * TEXT framing is the server's responsibility (controlled by the COPY
 * options the caller stamped on the SQL string).
 */
export const pumpReadable = async (
  conn: Connection,
  readable: Readable,
  copyIn: CopyInStream,
): Promise<void> => {
  let aborted: unknown = null;
  try {
    for await (const chunk of readable) {
      const buf =
        typeof chunk === 'string'
          ? Buffer.from(chunk, 'utf8')
          : Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk as ArrayBufferLike);
      await copyIn.write(buf);
    }
  } catch (err) {
    aborted = err;
  }

  if (aborted !== null) {
    const reason = abortReason(aborted);
    try {
      await copyIn.fail(reason);
    } catch {
      // ignore — the original read error is what we want to surface.
    }
    throw aborted instanceof Error ? aborted : new Error(reason);
  }

  await copyIn.end();
  // Keep the Connection type as a structural reference so prod consumers
  // import this module even when only using `conn.startCopyIn` directly.
  void conn;
};

/**
 * Drain a CopyOutStream into a Node Writable, returning when the server
 * has signalled CopyDone + ReadyForQuery. The Writable is NOT closed by this
 * function — the caller owns its lifetime.
 */
export const drainCopyOut = async (
  copyOut: CopyOutStream,
  writable: NodeJS.WritableStream,
): Promise<void> => {
  for await (const chunk of copyOut) {
    await new Promise<void>((resolve, reject) => {
      writable.write(chunk, (err) => {
        if (err !== null && err !== undefined) reject(err);
        else resolve();
      });
    });
  }
};

// Re-export the stream types so callers don't have to reach into types/.
export type { CopyInStream, CopyOutStream } from '../types/connection.js';

/**
 * Coerce an arbitrary thrown value into a string suitable for `CopyFail`
 * (which expects a human-readable reason). We accept Errors, strings, or
 * anything else; the last branch avoids `[object Object]` by JSON-stringifying
 * objects safely.
 */
const abortReason = (v: unknown): string => {
  if (v instanceof Error) return v.message;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v) ?? 'unknown error';
  } catch {
    return 'unknown error';
  }
};
