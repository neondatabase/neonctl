import { describe, expect, test } from 'vitest';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';

import {
  createScramClient,
  SaslMechanismError,
  SaslProtocolError,
  SaslVerificationError,
} from './sasl.js';

// ---------------------------------------------------------------------------
// Fake server — mirrors the math in sasl.ts so we get an end-to-end check
// without spinning up a real Postgres process. Uses node's crypto directly,
// so the test is independent of the client's helpers.
// ---------------------------------------------------------------------------

type FakeServerOpts = {
  password: string;
  salt: Buffer;
  iterations: number;
  serverNonceSuffix: string;
  /** If set, return this `e=` error instead of a normal final message. */
  finalError?: string;
  /** If set, tamper the `v=` server signature to simulate MITM. */
  tamperServerSignature?: boolean;
};

function runFakeServer(
  clientFirstMessage: Buffer,
  clientFinalMessage: Buffer,
  opts: FakeServerOpts,
): { serverFirst: Buffer; serverFinal: Buffer } {
  // Parse client first: <gs2><n=,r=clientNonce>
  const cf = clientFirstMessage.toString('utf8');
  const rIdx = cf.indexOf(',r=');
  if (rIdx < 0) throw new Error('test bug: missing r=');
  const clientNonce = cf.substring(rIdx + 3);
  // Reconstruct gs2 header + clientFirstBare
  // gs2 = everything before "n=" .. then "n=,r=<nonce>"
  const nIdx = cf.indexOf('n=');
  const clientFirstBare = cf.substring(nIdx);

  const combinedNonce = clientNonce + opts.serverNonceSuffix;
  const serverFirstString = `r=${combinedNonce},s=${opts.salt.toString(
    'base64',
  )},i=${String(opts.iterations)}`;
  const serverFirst = Buffer.from(serverFirstString, 'utf8');

  // Parse client final to reconstruct authMessage / verify proof.
  const cFinal = clientFinalMessage.toString('utf8');
  const pIdx = cFinal.lastIndexOf(',p=');
  if (pIdx < 0) throw new Error('test bug: missing p=');
  const clientFinalWithoutProof = cFinal.substring(0, pIdx);
  const clientProofB64 = cFinal.substring(pIdx + 3);

  const authMessage = `${clientFirstBare},${serverFirstString},${clientFinalWithoutProof}`;
  const saltedPassword = pbkdf2Sync(
    Buffer.from(opts.password, 'utf8'),
    opts.salt,
    opts.iterations,
    32,
    'sha256',
  );
  const clientKey = createHmac('sha256', saltedPassword)
    .update('Client Key')
    .digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const clientSignature = createHmac('sha256', storedKey)
    .update(authMessage)
    .digest();
  const expectedProof = Buffer.alloc(clientKey.length);
  for (let i = 0; i < clientKey.length; i++) {
    expectedProof[i] = clientKey[i] ^ clientSignature[i];
  }
  if (expectedProof.toString('base64') !== clientProofB64) {
    throw new Error(
      `test bug or auth failure: proof mismatch.\n` +
        `expected ${expectedProof.toString('base64')}\n` +
        `got      ${clientProofB64}`,
    );
  }

  const serverKey = createHmac('sha256', saltedPassword)
    .update('Server Key')
    .digest();
  let serverSig = createHmac('sha256', serverKey).update(authMessage).digest();
  if (opts.tamperServerSignature) {
    serverSig = Buffer.from(serverSig);
    serverSig[0] ^= 0xff;
  }

  let serverFinal: Buffer;
  if (opts.finalError) {
    serverFinal = Buffer.from(`e=${opts.finalError}`, 'utf8');
  } else {
    serverFinal = Buffer.from(`v=${serverSig.toString('base64')}`, 'utf8');
  }

  return { serverFirst, serverFinal };
}

const fixedRandom =
  (bytes: Buffer): ((n: number) => Buffer) =>
  (n: number) => {
    if (n !== bytes.length) {
      throw new Error(
        `fixedRandom: expected ${String(bytes.length)} bytes, got ${String(n)}`,
      );
    }
    return bytes;
  };

const NONCE_18 = Buffer.from('000102030405060708090a0b0c0d0e0f1011', 'hex');
// 18 bytes -> 24 base64 chars: "AAECAwQFBgcICQoLDA0ODxAR"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createScramClient', () => {
  test('end-to-end happy path (no channel binding)', () => {
    const client = createScramClient({
      user: 'user',
      password: 'pencil',
      mechanisms: ['SCRAM-SHA-256'],
      randomBytes: fixedRandom(NONCE_18),
    });

    expect(client.mechanism).toBe('SCRAM-SHA-256');

    const { mechanism, clientFirstMessage } = client.start();
    expect(mechanism).toBe('SCRAM-SHA-256');
    // gs2 header is "n,," because no channel binding.
    expect(clientFirstMessage.toString('utf8')).toBe(
      `n,,n=,r=${NONCE_18.toString('base64')}`,
    );

    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
    const fakeFirst = runFakeServerFirst(clientFirstMessage, {
      serverNonceSuffix: '%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0',
      salt,
      iterations: 4096,
    });

    const clientFinal = client.continue(fakeFirst);

    // c=biws (base64 of "n,,")
    expect(clientFinal.toString('utf8')).toContain('c=biws,');
    expect(clientFinal.toString('utf8')).toContain(
      `r=${NONCE_18.toString('base64')}%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=`,
    );

    const { serverFinal } = runFakeServer(clientFirstMessage, clientFinal, {
      password: 'pencil',
      salt,
      iterations: 4096,
      serverNonceSuffix: '%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0',
    });

    expect(() => {
      client.finish(serverFinal);
    }).not.toThrow();
  });

  test('end-to-end happy path with PLUS channel binding', () => {
    const cbData = Buffer.from('a'.repeat(32), 'utf8'); // pretend cert hash
    const client = createScramClient({
      user: 'user',
      password: 'pencil',
      mechanisms: ['SCRAM-SHA-256', 'SCRAM-SHA-256-PLUS'],
      channelBinding: { type: 'tls-server-end-point', data: cbData },
      randomBytes: fixedRandom(NONCE_18),
    });
    expect(client.mechanism).toBe('SCRAM-SHA-256-PLUS');

    const { clientFirstMessage } = client.start();
    expect(clientFirstMessage.toString('utf8')).toBe(
      `p=tls-server-end-point,,n=,r=${NONCE_18.toString('base64')}`,
    );

    const salt = Buffer.from('AAAAAAAAAAAAAAAA', 'base64');
    const serverNonceSuffix = 'serverNoncePart';
    const fakeFirst = runFakeServerFirst(clientFirstMessage, {
      serverNonceSuffix,
      salt,
      iterations: 1000,
    });

    const clientFinal = client.continue(fakeFirst);

    // c= should be base64 of ("p=tls-server-end-point,," || cbData)
    const expectedCbind = Buffer.concat([
      Buffer.from('p=tls-server-end-point,,', 'utf8'),
      cbData,
    ]).toString('base64');
    expect(clientFinal.toString('utf8')).toContain(`c=${expectedCbind},`);

    const { serverFinal } = runFakeServer(clientFirstMessage, clientFinal, {
      password: 'pencil',
      salt,
      iterations: 1000,
      serverNonceSuffix,
    });

    expect(() => {
      client.finish(serverFinal);
    }).not.toThrow();
  });

  test('falls back to SCRAM-SHA-256 with `y` when CB present but PLUS not advertised', () => {
    const client = createScramClient({
      user: 'user',
      password: 'pencil',
      mechanisms: ['SCRAM-SHA-256'],
      channelBinding: {
        type: 'tls-server-end-point',
        data: Buffer.alloc(32, 0xaa),
      },
      randomBytes: fixedRandom(NONCE_18),
    });
    expect(client.mechanism).toBe('SCRAM-SHA-256');

    const { clientFirstMessage } = client.start();
    expect(clientFirstMessage.toString('utf8')).toMatch(/^y,,n=,r=/);
  });

  test('uses `n` GS2 header when no channel binding', () => {
    const client = createScramClient({
      user: 'user',
      password: 'p',
      mechanisms: ['SCRAM-SHA-256', 'SCRAM-SHA-256-PLUS'],
      randomBytes: fixedRandom(NONCE_18),
    });
    expect(client.mechanism).toBe('SCRAM-SHA-256');
    const { clientFirstMessage } = client.start();
    expect(clientFirstMessage.toString('utf8')).toMatch(/^n,,n=,r=/);
  });

  test('throws SaslMechanismError when server offers only unsupported mechanisms', () => {
    expect(() =>
      createScramClient({
        user: 'user',
        password: 'p',
        mechanisms: ['DIGEST-MD5'],
        randomBytes: fixedRandom(NONCE_18),
      }),
    ).toThrow(SaslMechanismError);
  });

  test('throws SaslProtocolError on server-first missing r=', () => {
    const client = createScramClient({
      user: 'user',
      password: 'p',
      mechanisms: ['SCRAM-SHA-256'],
      randomBytes: fixedRandom(NONCE_18),
    });
    client.start();
    expect(() => client.continue(Buffer.from('s=AAAA,i=1000'))).toThrow(
      SaslProtocolError,
    );
  });

  test('throws SaslProtocolError on server-first missing s=', () => {
    const client = createScramClient({
      user: 'user',
      password: 'p',
      mechanisms: ['SCRAM-SHA-256'],
      randomBytes: fixedRandom(NONCE_18),
    });
    client.start();
    expect(() =>
      client.continue(
        Buffer.from(`r=${NONCE_18.toString('base64')}xyz,i=1000`),
      ),
    ).toThrow(SaslProtocolError);
  });

  test('throws SaslProtocolError on server-first missing i=', () => {
    const client = createScramClient({
      user: 'user',
      password: 'p',
      mechanisms: ['SCRAM-SHA-256'],
      randomBytes: fixedRandom(NONCE_18),
    });
    client.start();
    expect(() =>
      client.continue(
        Buffer.from(`r=${NONCE_18.toString('base64')}xyz,s=AAAA`),
      ),
    ).toThrow(SaslProtocolError);
  });

  test('throws SaslProtocolError on non-numeric iteration count', () => {
    const client = createScramClient({
      user: 'user',
      password: 'p',
      mechanisms: ['SCRAM-SHA-256'],
      randomBytes: fixedRandom(NONCE_18),
    });
    client.start();
    expect(() =>
      client.continue(
        Buffer.from(`r=${NONCE_18.toString('base64')}xyz,s=AAAA,i=abc`),
      ),
    ).toThrow(SaslProtocolError);
  });

  test('throws SaslProtocolError on a duplicate attribute in server-first', () => {
    const client = createScramClient({
      user: 'user',
      password: 'p',
      mechanisms: ['SCRAM-SHA-256'],
      randomBytes: fixedRandom(NONCE_18),
    });
    client.start();
    // Duplicate `i=` — a non-conformant/hostile server. Reject rather than
    // silently last-wins.
    expect(() =>
      client.continue(
        Buffer.from(`r=${NONCE_18.toString('base64')}xyz,s=AAAA,i=1000,i=2000`),
      ),
    ).toThrow(SaslProtocolError);
  });

  test('throws SaslProtocolError when server nonce does not start with client nonce', () => {
    const client = createScramClient({
      user: 'user',
      password: 'p',
      mechanisms: ['SCRAM-SHA-256'],
      randomBytes: fixedRandom(NONCE_18),
    });
    client.start();
    expect(() =>
      client.continue(Buffer.from('r=wrongNonce,s=AAAA,i=1000')),
    ).toThrow(SaslProtocolError);
  });

  test('throws SaslVerificationError on tampered server signature', () => {
    const client = createScramClient({
      user: 'user',
      password: 'pencil',
      mechanisms: ['SCRAM-SHA-256'],
      randomBytes: fixedRandom(NONCE_18),
    });
    const { clientFirstMessage } = client.start();
    const salt = Buffer.from('AAAAAAAAAAAAAAAA', 'base64');
    const fakeFirst = runFakeServerFirst(clientFirstMessage, {
      serverNonceSuffix: 'serverNoncePart',
      salt,
      iterations: 1000,
    });
    const clientFinal = client.continue(fakeFirst);
    const { serverFinal } = runFakeServer(clientFirstMessage, clientFinal, {
      password: 'pencil',
      salt,
      iterations: 1000,
      serverNonceSuffix: 'serverNoncePart',
      tamperServerSignature: true,
    });
    expect(() => {
      client.finish(serverFinal);
    }).toThrow(SaslVerificationError);
  });

  test('throws SaslVerificationError on server-final e= error (channel binding mismatch)', () => {
    const client = createScramClient({
      user: 'user',
      password: 'pencil',
      mechanisms: ['SCRAM-SHA-256'],
      randomBytes: fixedRandom(NONCE_18),
    });
    const { clientFirstMessage } = client.start();
    const salt = Buffer.from('AAAAAAAAAAAAAAAA', 'base64');
    const fakeFirst = runFakeServerFirst(clientFirstMessage, {
      serverNonceSuffix: 'serverNoncePart',
      salt,
      iterations: 1000,
    });
    const clientFinal = client.continue(fakeFirst);
    const { serverFinal } = runFakeServer(clientFirstMessage, clientFinal, {
      password: 'pencil',
      salt,
      iterations: 1000,
      serverNonceSuffix: 'serverNoncePart',
      finalError: 'channel-bindings-dont-match',
    });
    expect(() => {
      client.finish(serverFinal);
    }).toThrow(SaslVerificationError);
  });

  test('throws SaslProtocolError on server-final missing v=', () => {
    const client = createScramClient({
      user: 'user',
      password: 'pencil',
      mechanisms: ['SCRAM-SHA-256'],
      randomBytes: fixedRandom(NONCE_18),
    });
    const { clientFirstMessage } = client.start();
    const salt = Buffer.from('AAAAAAAAAAAAAAAA', 'base64');
    const fakeFirst = runFakeServerFirst(clientFirstMessage, {
      serverNonceSuffix: 'serverNoncePart',
      salt,
      iterations: 1000,
    });
    client.continue(fakeFirst);
    expect(() => {
      client.finish(Buffer.from('x=junk'));
    }).toThrow(SaslProtocolError);
  });

  test('state machine: continue() before start() rejects', () => {
    const client = createScramClient({
      user: 'user',
      password: 'p',
      mechanisms: ['SCRAM-SHA-256'],
      randomBytes: fixedRandom(NONCE_18),
    });
    expect(() => client.continue(Buffer.from('r=x,s=A,i=1'))).toThrow(
      SaslProtocolError,
    );
  });

  test('state machine: finish() before continue() rejects', () => {
    const client = createScramClient({
      user: 'user',
      password: 'p',
      mechanisms: ['SCRAM-SHA-256'],
      randomBytes: fixedRandom(NONCE_18),
    });
    client.start();
    expect(() => {
      client.finish(Buffer.from('v=A'));
    }).toThrow(SaslProtocolError);
  });

  test('nonce randomness defaults to crypto.randomBytes (smoke test)', () => {
    const a = createScramClient({
      user: 'u',
      password: 'p',
      mechanisms: ['SCRAM-SHA-256'],
    });
    const b = createScramClient({
      user: 'u',
      password: 'p',
      mechanisms: ['SCRAM-SHA-256'],
    });
    expect(a.start().clientFirstMessage.toString('utf8')).not.toBe(
      b.start().clientFirstMessage.toString('utf8'),
    );
  });
});

// Helper that only produces the server-first message (used when we don't yet
// have the client-final to verify against).
function runFakeServerFirst(
  clientFirstMessage: Buffer,
  opts: { serverNonceSuffix: string; salt: Buffer; iterations: number },
): Buffer {
  const cf = clientFirstMessage.toString('utf8');
  const rIdx = cf.indexOf(',r=');
  if (rIdx < 0) throw new Error('test bug: missing r=');
  const clientNonce = cf.substring(rIdx + 3);
  const combinedNonce = clientNonce + opts.serverNonceSuffix;
  return Buffer.from(
    `r=${combinedNonce},s=${opts.salt.toString('base64')},i=${String(opts.iterations)}`,
    'utf8',
  );
}
