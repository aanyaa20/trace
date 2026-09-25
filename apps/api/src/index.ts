import { env } from './env.js';
import { logger } from './logger.js';
import { buildServer } from './server.js';
import { closeDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { ensureCollection } from './qdrant/bootstrap.js';
import { db } from './db/client.js';
import { connectors } from './db/schema.js';
import { reconcileMailboxSchedules } from './queue/queues.js';
import { toError } from './errors.js';

async function main(): Promise<void> {
  if (env.RUN_MIGRATIONS_ON_BOOT) {
    await runMigrations();
    logger.info('database migrations applied');
  }

  await ensureCollection(logger);

  // Connector rows outlive the Redis keys that poll them, so the schedule is
  // rebuilt from the database rather than assumed to have survived.
  const rows = await db.select({ id: connectors.id }).from(connectors);
  const { restored } = await reconcileMailboxSchedules(rows.map((row) => row.id));
  if (restored > 0) {
    logger.warn({ restored, total: rows.length }, 'mailbox schedules were missing and were restored');
  } else {
    logger.info({ connectors: rows.length }, 'mailbox schedules reconciled');
  }

  const app = await buildServer();
  await app.listen({ host: env.API_HOST, port: env.API_PORT });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    // Fastify stops accepting connections and drains in-flight requests before
    // the database pool closes, so a streaming answer is not cut mid-frame.
    void app
      .close()
      .then(closeDatabase)
      .then(() => process.exit(0))
      .catch((cause: unknown) => {
        logger.error({ err: toError(cause) }, 'shutdown failed');
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((cause: unknown) => {
  logger.fatal({ err: toError(cause) }, 'api failed to start');
  process.exit(1);
});
