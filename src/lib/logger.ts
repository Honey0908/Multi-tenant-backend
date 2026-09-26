import pino from 'pino';

// Quiet by default under the test runner (vitest sets NODE_ENV=test) so
// `npm test` output stays readable — LOG_LEVEL still overrides explicitly.
const defaultLevel = process.env.NODE_ENV === 'test' ? 'warn' : 'info';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? defaultLevel,
  redact: {
    paths: [
      'req.headers.authorization',
      'password',
      'password_hash',
      '*.password',
      '*.password_hash',
    ],
    censor: '[REDACTED]',
  },
});
