import { pino, type Logger } from 'pino';
import { env } from './env.js';

// pino-pretty is a dev dependency, so a production image must never reference
// the transport. Structured JSON is the right output there anyway.
const transport =
  env.NODE_ENV === 'development'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
    : undefined;

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'api' },
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.apiKey'],
    remove: true,
  },
  ...(transport ? { transport } : {}),
});

