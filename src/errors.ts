import { isAxiosError } from 'axios';

export type ErrorCode =
  | 'REQUEST_TIMEOUT'
  | 'NETWORK_ERROR'
  | 'AUTH_FAILED'
  | 'AUTH_BROWSER_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMIT'
  | 'API_ERROR'
  | 'UNKNOWN_COMMAND'
  | 'MISSING_ARGUMENT'
  | 'USAGE_ERROR'
  | 'CREDENTIALS_DELETE_FAILED'
  | 'NPX_NOT_FOUND'
  | 'NEON_INIT_FAILED'
  | 'UNKNOWN_ERROR';

// Documented in README. Keep in sync.
export const EXIT_CODES: Record<ErrorCode, number> = {
  UNKNOWN_COMMAND: 2,
  MISSING_ARGUMENT: 2,
  USAGE_ERROR: 2,
  AUTH_FAILED: 3,
  AUTH_BROWSER_FAILED: 3,
  NOT_FOUND: 4,
  CONFLICT: 5,
  RATE_LIMIT: 6,
  REQUEST_TIMEOUT: 7,
  NETWORK_ERROR: 7,
  API_ERROR: 1,
  CREDENTIALS_DELETE_FAILED: 1,
  NPX_NOT_FOUND: 1,
  NEON_INIT_FAILED: 1,
  UNKNOWN_ERROR: 1,
};

export const exitCodeForError = (code: ErrorCode): number => EXIT_CODES[code];

const ERROR_MATCHERS = [
  [/^Unknown command: (.*)$/, 'UNKNOWN_COMMAND'],
  [/^Missing required argument: (.*)$/, 'MISSING_ARGUMENT'],
  [/^Failed to open web browser. (.*)$/, 'AUTH_BROWSER_FAILED'],
] as const;

// Yargs surfaces validation failures as plain Errors with messages that start
// with one of these stable prefixes. Treat them all as USAGE_ERROR (exit 2)
// even when the specific prefix isn't in ERROR_MATCHERS.
const YARGS_USAGE_PREFIXES = [
  'Unknown command:',
  'Unknown argument:',
  'Unknown arguments:',
  'Missing required argument:',
  'Missing required arguments:',
  'Not enough non-option arguments:',
  'Too many non-option arguments:',
  'Invalid values:',
  'Did you mean ',
];

export const matchErrorCode = (message?: string): ErrorCode => {
  if (!message) {
    return 'UNKNOWN_ERROR';
  }
  for (const [matcher, code] of ERROR_MATCHERS) {
    const match = message.match(matcher);
    if (match) {
      return code;
    }
  }
  if (YARGS_USAGE_PREFIXES.some((prefix) => message.startsWith(prefix))) {
    return 'USAGE_ERROR';
  }
  return 'UNKNOWN_ERROR';
};

// Classify an error caught from the API client / network into an ErrorCode at
// the source. Non-axios errors fall through to message-based matching.
export const classifyError = (err: unknown): ErrorCode => {
  if (isAxiosError(err)) {
    if (
      err.code === 'ECONNABORTED' ||
      err.code === 'ETIMEDOUT' ||
      err.code === 'ESOCKETTIMEDOUT'
    ) {
      return 'REQUEST_TIMEOUT';
    }
    if (!err.response) {
      // Connection refused, DNS failure, etc.
      return 'NETWORK_ERROR';
    }
    const status = err.response.status;
    if (status === 401 || status === 403) {
      return 'AUTH_FAILED';
    }
    if (status === 404) {
      return 'NOT_FOUND';
    }
    if (status === 409) {
      return 'CONFLICT';
    }
    if (status === 429) {
      return 'RATE_LIMIT';
    }
    return 'API_ERROR';
  }
  if (err instanceof Error) {
    return matchErrorCode(err.message);
  }
  return 'UNKNOWN_ERROR';
};
