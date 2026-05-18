import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import {
  classifyError,
  EXIT_CODES,
  ErrorCode,
  exitCodeForError,
  matchErrorCode,
} from './errors';

const makeAxiosError = (opts: {
  status?: number;
  code?: string;
  message?: string;
}): AxiosError => {
  const err = new AxiosError(
    opts.message ?? 'request failed',
    opts.code,
    undefined,
    undefined,
    opts.status !== undefined
      ? {
          status: opts.status,
          statusText: '',
          data: undefined,
          headers: new AxiosHeaders(),
          config: { headers: new AxiosHeaders() } as never,
        }
      : undefined,
  );
  return err;
};

describe('classifyError', () => {
  it('maps ECONNABORTED to REQUEST_TIMEOUT', () => {
    expect(classifyError(makeAxiosError({ code: 'ECONNABORTED' }))).toBe(
      'REQUEST_TIMEOUT',
    );
  });

  it('maps ETIMEDOUT to REQUEST_TIMEOUT', () => {
    expect(classifyError(makeAxiosError({ code: 'ETIMEDOUT' }))).toBe(
      'REQUEST_TIMEOUT',
    );
  });

  it('maps axios error without response to NETWORK_ERROR', () => {
    expect(classifyError(makeAxiosError({ code: 'ECONNREFUSED' }))).toBe(
      'NETWORK_ERROR',
    );
  });

  it('maps 401 to AUTH_FAILED', () => {
    expect(classifyError(makeAxiosError({ status: 401 }))).toBe('AUTH_FAILED');
  });

  it('maps 403 to AUTH_FAILED', () => {
    expect(classifyError(makeAxiosError({ status: 403 }))).toBe('AUTH_FAILED');
  });

  it('maps 404 to NOT_FOUND', () => {
    expect(classifyError(makeAxiosError({ status: 404 }))).toBe('NOT_FOUND');
  });

  it('maps 409 to CONFLICT', () => {
    expect(classifyError(makeAxiosError({ status: 409 }))).toBe('CONFLICT');
  });

  it('maps 429 to RATE_LIMIT', () => {
    expect(classifyError(makeAxiosError({ status: 429 }))).toBe('RATE_LIMIT');
  });

  it('maps other 4xx to API_ERROR', () => {
    expect(classifyError(makeAxiosError({ status: 400 }))).toBe('API_ERROR');
  });

  it('maps 5xx to API_ERROR', () => {
    expect(classifyError(makeAxiosError({ status: 500 }))).toBe('API_ERROR');
    expect(classifyError(makeAxiosError({ status: 503 }))).toBe('API_ERROR');
  });

  it('classifies yargs usage errors as USAGE_ERROR', () => {
    expect(classifyError(new Error('Unknown argument: foo'))).toBe(
      'USAGE_ERROR',
    );
    expect(classifyError(new Error('Not enough non-option arguments: 0'))).toBe(
      'USAGE_ERROR',
    );
  });

  it('keeps regex-matched specific codes for known yargs prefixes', () => {
    expect(classifyError(new Error('Unknown command: foo'))).toBe(
      'UNKNOWN_COMMAND',
    );
    expect(classifyError(new Error('Missing required argument: bar'))).toBe(
      'MISSING_ARGUMENT',
    );
  });

  it('falls through to UNKNOWN_ERROR for generic errors', () => {
    expect(classifyError(new Error('something else broke'))).toBe(
      'UNKNOWN_ERROR',
    );
  });

  it('handles non-Error inputs', () => {
    expect(classifyError(undefined)).toBe('UNKNOWN_ERROR');
    expect(classifyError('a string')).toBe('UNKNOWN_ERROR');
  });
});

describe('exitCodeForError / EXIT_CODES', () => {
  it.each<[ErrorCode, number]>([
    ['UNKNOWN_COMMAND', 2],
    ['MISSING_ARGUMENT', 2],
    ['USAGE_ERROR', 2],
    ['AUTH_FAILED', 3],
    ['AUTH_BROWSER_FAILED', 3],
    ['NOT_FOUND', 4],
    ['CONFLICT', 5],
    ['RATE_LIMIT', 6],
    ['REQUEST_TIMEOUT', 7],
    ['NETWORK_ERROR', 7],
    ['API_ERROR', 1],
    ['UNKNOWN_ERROR', 1],
    ['CREDENTIALS_DELETE_FAILED', 1],
    ['NPX_NOT_FOUND', 1],
    ['NEON_INIT_FAILED', 1],
  ])('maps %s to exit code %i', (code, exit) => {
    expect(exitCodeForError(code)).toBe(exit);
    expect(EXIT_CODES[code]).toBe(exit);
  });
});

describe('matchErrorCode', () => {
  it('handles undefined message', () => {
    expect(matchErrorCode(undefined)).toBe('UNKNOWN_ERROR');
  });
});
