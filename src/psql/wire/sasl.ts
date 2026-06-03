/**
 * SASL / SCRAM-SHA-256[-PLUS] client for the psql wire layer (WP-03).
 *
 * Ported from node-postgres' `packages/pg/lib/crypto/sasl.js` (MIT,
 * Copyright (c) 2010-2020 Brian Carlson). Adaptations from upstream:
 *
 *   - Pure Node `node:crypto` (sync PBKDF2 / HMAC) instead of SubtleCrypto;
 *     this module is sync because the wire layer drives it from a state
 *     machine that already buffers bytes.
 *   - The `pg` `Connection` / `Stream` plumbing is removed. Channel binding
 *     data (the certificate hash) is passed in as `Buffer` by the caller,
 *     not derived from a TLS socket. The caller (WP-02) is responsible for
 *     extracting `tls-server-end-point` per RFC 5929 (i.e. SHA-256 over
 *     the cert's `tbsCertificate`, or the cert's own signature hash when
 *     strong enough — that policy lives upstream of this module).
 *   - Returns Buffer-typed messages because the wire framer consumes
 *     Buffers; upstream pg works in strings because its message reader
 *     does the same.
 *   - SASLprep: ported upstream's permissive minimal SASLprep (the three
 *     transformations that actually change byte content). The full RFC
 *     4013 prohibition + bidi tables are *not* implemented — matches
 *     libpq's and pg's behaviour, see comment on `saslprep` below.
 *
 * Server signature verification uses `crypto.timingSafeEqual` to avoid
 * leaking timing information about the comparison result.
 */

import {
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from 'node:crypto';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ScramMechanism = 'SCRAM-SHA-256' | 'SCRAM-SHA-256-PLUS';

export type ScramChannelBinding = {
  /** RFC 5929 channel-binding type. Only `tls-server-end-point` is supported. */
  type: 'tls-server-end-point';
  /** The hash of the server certificate (e.g. SHA-256 of `tbsCertificate`). */
  data: Buffer;
};

export type ScramOptions = {
  user: string;
  password: string;
  /** Server-advertised mechanism list (e.g. from AuthenticationSASL). */
  mechanisms: string[];
  /** If present, the connection has TLS data the caller can bind to. */
  channelBinding?: ScramChannelBinding;
  /** Override the source of client-nonce randomness (used by tests). */
  randomBytes?: (n: number) => Buffer;
};

export type ScramClient = {
  mechanism: ScramMechanism;
  /**
   * First step. Caller frames the result into a SASLInitialResponse:
   * `mechanism` is written as a NUL-terminated cstring, then `clientFirstMessage`
   * is written as an `int32 length` followed by its bytes.
   */
  start: () => { mechanism: string; clientFirstMessage: Buffer };
  /** Process server-first message body. Returns the client-final message body. */
  continue: (serverFirst: Buffer) => Buffer;
  /** Process server-final message body. Throws on signature mismatch / error. */
  finish: (serverFinal: Buffer) => void;
};

export class SaslMechanismError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SaslMechanismError';
  }
}

export class SaslVerificationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SaslVerificationError';
  }
}

export class SaslProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SaslProtocolError';
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

type State = 'init' | 'sent-first' | 'sent-final' | 'done';

type Internal = {
  state: State;
  mechanism: ScramMechanism;
  clientNonce: string;
  gs2Header: string;
  /** Raw bytes that go into the base64-encoded `c=` attribute on the client-final. */
  cbindInput: Buffer;
  password: string;
  serverSignature: Buffer | null;
};

export function createScramClient(opts: ScramOptions): ScramClient {
  const { mechanism, gs2Header, cbindInput } = chooseMechanism(
    opts.mechanisms,
    opts.channelBinding,
  );

  const rng = opts.randomBytes ?? nodeRandomBytes;
  // 18 raw bytes => 24 base64 chars; same width as upstream pg.
  // Commas are not part of the base64 alphabet, so the nonce is automatically
  // SCRAM-safe (RFC 5802 §5.1 forbids `,` in `r=`).
  const clientNonce = rng(18).toString('base64');

  const internal: Internal = {
    state: 'init',
    mechanism,
    clientNonce,
    gs2Header,
    cbindInput,
    password: opts.password,
    serverSignature: null,
  };

  return {
    mechanism,
    start: () => start(internal),
    continue: (serverFirst) => continueSession(internal, serverFirst),
    finish: (serverFinal) => {
      finishSession(internal, serverFinal);
    },
  };
}

function chooseMechanism(
  advertised: string[],
  channelBinding: ScramChannelBinding | undefined,
): { mechanism: ScramMechanism; gs2Header: string; cbindInput: Buffer } {
  const hasPlus = advertised.includes('SCRAM-SHA-256-PLUS');
  const hasPlain = advertised.includes('SCRAM-SHA-256');

  if (channelBinding && hasPlus) {
    const gs2 = 'p=tls-server-end-point,,';
    return {
      mechanism: 'SCRAM-SHA-256-PLUS',
      gs2Header: gs2,
      cbindInput: Buffer.concat([
        Buffer.from(gs2, 'utf8'),
        channelBinding.data,
      ]),
    };
  }

  if (hasPlain) {
    // Client has channel-binding data but server doesn't advertise PLUS: per
    // RFC 5802 §6 the client must signal this with `y` so a downgrade attack
    // is detected (the server, if PLUS-capable, would have advertised it).
    const gs2 = channelBinding ? 'y,,' : 'n,,';
    return {
      mechanism: 'SCRAM-SHA-256',
      gs2Header: gs2,
      cbindInput: Buffer.from(gs2, 'utf8'),
    };
  }

  throw new SaslMechanismError(
    `SASL: server offered [${advertised.join(', ')}] but only SCRAM-SHA-256 and SCRAM-SHA-256-PLUS are supported`,
  );
}

function start(s: Internal): { mechanism: string; clientFirstMessage: Buffer } {
  if (s.state !== 'init') {
    throw new SaslProtocolError(`SASL: start() called in state ${s.state}`);
  }
  // n=,r=<nonce> — the username field is empty because PostgreSQL ignores it
  // (the actual user was sent in StartupMessage) and an empty `n=` matches
  // libpq's wire output. Note pg sends `n=*` instead; both interoperate.
  const clientFirstBare = `n=,r=${s.clientNonce}`;
  const clientFirstMessage = Buffer.from(s.gs2Header + clientFirstBare, 'utf8');
  s.state = 'sent-first';
  return { mechanism: s.mechanism, clientFirstMessage };
}

function continueSession(s: Internal, serverFirst: Buffer): Buffer {
  if (s.state !== 'sent-first') {
    throw new SaslProtocolError(`SASL: continue() called in state ${s.state}`);
  }

  const serverFirstStr = serverFirst.toString('utf8');
  const parsed = parseServerFirst(serverFirstStr);

  if (!parsed.nonce.startsWith(s.clientNonce)) {
    throw new SaslProtocolError(
      'SASL: server nonce does not start with client nonce',
    );
  }
  if (parsed.nonce.length === s.clientNonce.length) {
    throw new SaslProtocolError('SASL: server nonce is too short');
  }

  const clientFirstBare = `n=,r=${s.clientNonce}`;
  const serverFirstString = `r=${parsed.nonce},s=${parsed.salt},i=${String(parsed.iteration)}`;

  // c=<base64 of GS2 header || optional CB data>
  const channelBindingB64 = s.cbindInput.toString('base64');
  const clientFinalWithoutProof = `c=${channelBindingB64},r=${parsed.nonce}`;

  const authMessage = `${clientFirstBare},${serverFirstString},${clientFinalWithoutProof}`;

  const saltBytes = Buffer.from(parsed.salt, 'base64');
  // SASLprep the password before PBKDF2 (RFC 5802 §2.2). Our impl is minimal;
  // see saslprep() comment for the deviation from full RFC 4013.
  const normalizedPassword = saslprep(s.password);
  const saltedPassword = pbkdf2Sync(
    Buffer.from(normalizedPassword, 'utf8'),
    saltBytes,
    parsed.iteration,
    32,
    'sha256',
  );

  const clientKey = hmac(saltedPassword, 'Client Key');
  const storedKey = sha256(clientKey);
  const clientSignature = hmac(storedKey, authMessage);
  const clientProof = xor(clientKey, clientSignature);

  const serverKey = hmac(saltedPassword, 'Server Key');
  s.serverSignature = hmac(serverKey, authMessage);

  s.state = 'sent-final';
  return Buffer.from(
    `${clientFinalWithoutProof},p=${clientProof.toString('base64')}`,
    'utf8',
  );
}

function finishSession(s: Internal, serverFinal: Buffer): void {
  if (s.state !== 'sent-final') {
    throw new SaslProtocolError(`SASL: finish() called in state ${s.state}`);
  }
  if (s.serverSignature === null) {
    // Defensive: should be impossible because state machine guards it.
    throw new SaslProtocolError('SASL: no server signature recorded');
  }

  const parsed = parseServerFinal(serverFinal.toString('utf8'));
  const received = Buffer.from(parsed.serverSignature, 'base64');

  // Constant-time comparison: defeats timing side channels that could let an
  // attacker (with control over `v=`) learn the prefix of our derived signature.
  if (
    received.length !== s.serverSignature.length ||
    !timingSafeEqual(received, s.serverSignature)
  ) {
    throw new SaslVerificationError(
      'SASL: server signature does not match — possible MITM or wrong password',
    );
  }

  s.state = 'done';
}

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

type ServerFirst = { nonce: string; salt: string; iteration: number };

function parseServerFirst(text: string): ServerFirst {
  const attrs = parseAttributePairs(text);

  const nonce = attrs.get('r');
  if (!nonce) {
    throw new SaslProtocolError('SASL: server-first missing `r=` (nonce)');
  }
  if (!isPrintableChars(nonce)) {
    throw new SaslProtocolError(
      'SASL: server-first nonce contains non-printable characters',
    );
  }

  const salt = attrs.get('s');
  if (!salt) {
    throw new SaslProtocolError('SASL: server-first missing `s=` (salt)');
  }
  if (!isBase64(salt)) {
    throw new SaslProtocolError('SASL: server-first salt is not base64');
  }

  const iterStr = attrs.get('i');
  if (!iterStr) {
    throw new SaslProtocolError('SASL: server-first missing `i=` (iterations)');
  }
  if (!/^[1-9][0-9]*$/.test(iterStr)) {
    throw new SaslProtocolError(
      `SASL: server-first iteration count is not a positive integer: ${iterStr}`,
    );
  }

  return { nonce, salt, iteration: parseInt(iterStr, 10) };
}

type ServerFinal = { serverSignature: string };

function parseServerFinal(text: string): ServerFinal {
  const attrs = parseAttributePairs(text);
  const errorAttr = attrs.get('e');
  if (errorAttr) {
    throw new SaslVerificationError(
      `SASL: server-final returned error: ${errorAttr}`,
    );
  }

  const v = attrs.get('v');
  if (!v) {
    throw new SaslProtocolError(
      'SASL: server-final missing `v=` (server signature)',
    );
  }
  if (!isBase64(v)) {
    throw new SaslProtocolError('SASL: server-final `v=` is not base64');
  }
  return { serverSignature: v };
}

function parseAttributePairs(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of text.split(',')) {
    if (pair.length < 2 || pair[1] !== '=') {
      throw new SaslProtocolError(
        `SASL: malformed attribute pair: ${JSON.stringify(pair)}`,
      );
    }
    const key = pair[0];
    // RFC 5802 attribute lists never repeat an attribute; a duplicate is
    // malformed server input. Reject it rather than silently last-wins,
    // so a non-conformant/hostile server can't smuggle a shadow value
    // (e.g. `v=<good>,v=<evil>`) past the parse.
    if (out.has(key)) {
      throw new SaslProtocolError(
        `SASL: duplicate attribute ${JSON.stringify(key)} in message`,
      );
    }
    out.set(key, pair.substring(2));
  }
  return out;
}

// printable = %x21-2B / %x2D-7E  ;; printable ASCII except ","
function isPrintableChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (!((c >= 0x21 && c <= 0x2b) || (c >= 0x2d && c <= 0x7e))) {
      return false;
    }
  }
  return true;
}

function isBase64(text: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
    text,
  );
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function hmac(key: Buffer, msg: string | Buffer): Buffer {
  const h = createHmac('sha256', key);
  h.update(msg);
  return h.digest();
}

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function xor(a: Buffer, b: Buffer): Buffer {
  if (a.length !== b.length) {
    throw new SaslProtocolError(
      `SASL: XOR length mismatch (${String(a.length)} vs ${String(b.length)})`,
    );
  }
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] ^ b[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// SASLprep
// ---------------------------------------------------------------------------

/**
 * Minimal SASLprep (RFC 4013) — exactly the three transformations that
 * change byte content, ported from node-postgres' implementation:
 *
 *   1. RFC 3454 Table C.1.2 (non-ASCII space) -> U+0020 SPACE.
 *   2. RFC 3454 Table B.1 (commonly mapped to nothing) -> empty.
 *   3. NFKC normalization.
 *
 * We deliberately *skip* the RFC 4013 §2.3 prohibition table and the §6
 * bidi checks. libpq is forgiving on those paths and PostgreSQL's own
 * SASLprep matches that leniency for legacy roles — implementing strict
 * RFC 4013 here would lock out passwords that already auth against the
 * server. This deviation matches upstream pg.
 *
 * The character classes below intentionally contain combining marks and
 * zero-width joiners (RFC 3454 Table B.1) and named spaces (Table C.1.2);
 * they are spelled with `\u` escapes so the source is portable across
 * encodings.
 */
// Built once at module load: regex character classes for the two SASLprep
// transformations. They are constructed from \uXXXX escape sequences in a
// string so the source file stays ASCII-only and so we sidestep ESLint's
// `no-irregular-whitespace` and `no-misleading-character-class` rules —
// those only inspect raw regex literals, not dynamically-built patterns.
const NON_ASCII_SPACE_RE = new RegExp(
  '[' + '\u00A0\u1680' + '\u2000-\u200B' + '\u202F\u205F\u3000' + ']',
  'g',
);
// Combining marks and ZWJ are intentionally in this class; RFC 3454 Table B.1
// strips them precisely because they combine with neighbouring code points.
/* eslint-disable no-misleading-character-class */
const MAPPED_TO_NOTHING_RE = new RegExp(
  '[' +
    '\u00AD\u034F\u1806' +
    '\u180B-\u180D' +
    '\u200C\u200D\u2060' +
    '\uFE00-\uFE0F' +
    '\uFEFF' +
    ']',
  'g',
);
/* eslint-enable no-misleading-character-class */

function saslprep(password: string): string {
  return password
    .replace(NON_ASCII_SPACE_RE, ' ')
    .replace(MAPPED_TO_NOTHING_RE, '')
    .normalize('NFKC');
}
