import { pinoHttp } from 'pino-http';
import type { IncomingMessage } from 'node:http';
import { logger } from '../lib/logger.js';

/**
 * One structured log line per request/response (method, path, status,
 * duration, a generated request id) — the baseline "who did what, when"
 * audit trail the rest of the security logging (quota failures, auth
 * rejections in errorHandler) attaches onto via matching request ids.
 */
export const requestLogger = pinoHttp({
  logger,
  autoLogging: {
    ignore: (req: IncomingMessage) => req.url === '/health',
  },
});
