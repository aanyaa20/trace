import { Worker } from 'bullmq';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { toError } from '../errors.js';
import { closeDatabase } from '../db/client.js';
import { ingestDocument } from '../ingest/pipeline.js';
import { syncConnector } from '../ingest/mailbox.js';
import { createRedis } from './connection.js';
import { INGESTION_QUEUE, MAILBOX_QUEUE, type IngestionJob, type MailboxJob } from './queues.js';

const worker = new Worker<IngestionJob>(
  INGESTION_QUEUE,
  async (job) => {
    const started = Date.now();
    logger.info({ documentId: job.data.documentId, attempt: job.attemptsMade + 1 }, 'ingestion started');
    await ingestDocument(job.data.documentId);
    logger.info(
      { documentId: job.data.documentId, ms: Date.now() - started },
      'ingestion finished',
    );
  },
  {
    connection: createRedis(),
    concurrency: env.INGEST_CONCURRENCY,
    // Whisper on a long recording can hold a job well past the default lock,
    // and a renewed lock is what stops a second worker taking it over.
    lockDuration: 10 * 60_000,
  },
);

worker.on('failed', (job, error) => {
  logger.error(
    { documentId: job?.data.documentId, attempt: job?.attemptsMade, err: error },
    'ingestion job failed',
  );
});

worker.on('error', (error) => {
  logger.error({ err: error }, 'ingestion worker error');
});

/**
 * Mailbox polling is a separate worker with concurrency 1. Sharing the
 * ingestion worker would let a slow IMAP round trip occupy a slot that whisper
 * needs, and two syncs of one mailbox at once would race the same watermark.
 */
const mailboxWorker = new Worker<MailboxJob>(
  MAILBOX_QUEUE,
  async (job) => {
    const started = Date.now();
    const result = await syncConnector(job.data.connectorId);
    logger.info(
      { ms: Date.now() - started, ...result },
      'mailbox sync complete',
    );
  },
  { connection: createRedis(), concurrency: 1, lockDuration: 10 * 60_000 },
);

mailboxWorker.on('failed', (job, error) => {
  logger.error(
    { connectorId: job?.data.connectorId, attempt: job?.attemptsMade, err: error },
    'mailbox sync failed',
  );
});

mailboxWorker.on('error', (error) => {
  logger.error({ err: error }, 'mailbox worker error');
});

logger.info(
  { concurrency: env.INGEST_CONCURRENCY, mailboxPollSeconds: env.MAILBOX_POLL_SECONDS },
  'workers ready',
);

const shutdown = (signal: string): void => {
  logger.info({ signal }, 'worker shutting down');
  void Promise.all([worker.close(), mailboxWorker.close()])
    .then(closeDatabase)
    .then(() => process.exit(0))
    .catch((cause: unknown) => {
      logger.error({ err: toError(cause) }, 'worker shutdown failed');
      process.exit(1);
    });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
