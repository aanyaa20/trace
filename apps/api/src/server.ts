import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import { env } from './env.js';
import { logger } from './logger.js';
import authPlugin from './plugins/auth.js';
import errorHandlerPlugin from './plugins/errorHandler.js';
import authRoutes from './routes/auth.js';
import chatRoutes from './routes/chat.js';
import evaluationRoutes from './routes/evaluation.js';
import citationRoutes from './routes/citations.js';
import connectorRoutes from './routes/connectors.js';
import documentRoutes from './routes/documents.js';
import embeddingMapRoutes from './routes/embeddingMap.js';
import eventRoutes from './routes/events.js';
import healthRoutes from './routes/health.js';
import kbRoutes from './routes/kb.js';
import previewRoutes from './routes/preview.js';
import urlRoutes from './routes/urls.js';

function createApp() {
  return Fastify({
    loggerInstance: logger,
    // Uploads arrive as multipart, but a proxy that rewrites a large request
    // body still must not be able to exhaust memory here.
    bodyLimit: 1024 * 1024,
    trustProxy: true,
    disableRequestLogging: env.NODE_ENV !== 'development',
  });
}

/** Passing a pino instance specialises the logger generic, so the concrete
 *  instance type is derived rather than restated. */
export type TraceServer = ReturnType<typeof createApp>;

export async function buildServer(): Promise<TraceServer> {
  const app = createApp();

  await app.register(errorHandlerPlugin);
  await app.register(fastifyCors, {
    origin: env.CORS_ORIGIN.split(',').map((value) => value.trim()),
    credentials: true,
    // Stated explicitly rather than left to the default. Without DELETE here
    // the browser rejects every delete at the preflight, so removing a
    // document or disconnecting a mailbox fails with a CORS error while the
    // same request from curl succeeds — which is exactly the asymmetry that
    // makes a browser-only bug look like a server bug.
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });
  await app.register(fastifyMultipart, {
    limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 20 },
  });
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(kbRoutes);
  await app.register(documentRoutes);
  await app.register(urlRoutes);
  await app.register(connectorRoutes);
  await app.register(previewRoutes);
  await app.register(eventRoutes);
  await app.register(chatRoutes);
  await app.register(evaluationRoutes);
  await app.register(citationRoutes);
  await app.register(embeddingMapRoutes);

  return app;
}
