export type ErrorCode =
  | 'REQUEST_TIMEOUT'
  | 'AUTH_FAILED'
  | 'API_ERROR'
  | 'UNKNOWN_COMMAND'
  | 'MISSING_ARGUMENT'
  | 'UNKNOWN_ERROR';

const ERROR_MATCHERS = [
  [/^Unknown command: (.*)$/, 'UNKNOWN_COMMAND'],
  [/^Missing required argument: (.*)$/, 'MISSING_ARGUMENT'],
  [/^Failed to open web browser. (.*)$/, 'AUTH_FAILED'],
] as const;

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
  return 'UNKNOWN_ERROR';
};
