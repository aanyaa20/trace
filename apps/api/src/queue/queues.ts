import { Queue } from 'bullmq';
import { env } from '../env.js';
import { redis } from './connection.js';

export const INGESTION_QUEUE = 'ingestion';
export const MAILBOX_QUEUE = 'mailbox';

export interface IngestionJob {
  documentId: string;
  kbId: string;
}

export const ingestionQueue = new Queue<IngestionJob>(INGESTION_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    // Extraction is expensive and rarely fails transiently; a second attempt
    // covers a restarted ml container without re-running whisper four times.
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  },
});

export async function enqueueIngestion(job: IngestionJob): Promise<void> {
  // The document id is the job id, so a double-submitted upload cannot be
  // ingested twice.
  await ingestionQueue.add('ingest', job, { jobId: job.documentId });
}

export interface MailboxJob {
  connectorId: string;
}

export const mailboxQueue = new Queue<MailboxJob>(MAILBOX_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    // A failed poll is usually the network or a rate limit, both of which clear
    // on their own; the watermark means a retry costs nothing it already did.
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  },
});

/** The scheduler id is the connector id, so re-connecting the same mailbox
 *  replaces its schedule instead of adding a second one. */
function schedulerId(connectorId: string): string {
  return `mailbox:${connectorId}`;
}

export async function scheduleMailboxSync(connectorId: string): Promise<void> {
  await mailboxQueue.upsertJobScheduler(
    schedulerId(connectorId),
    { every: env.MAILBOX_POLL_SECONDS * 1000 },
    { name: 'sync', data: { connectorId } },
  );
}

export async function unscheduleMailboxSync(connectorId: string): Promise<void> {
  await mailboxQueue.removeJobScheduler(schedulerId(connectorId));
}

/** An out-of-band sync, for the moment a mailbox is connected and for the
 *  'sync now' button. Deduplicated against a poll already in flight. */
export async function enqueueMailboxSync(connectorId: string): Promise<void> {
  await mailboxQueue.add(
    'sync',
    { connectorId },
    { jobId: `mailbox-now:${connectorId}:${Date.now()}`, attempts: 1 },
  );
}

/**
 * Re-registers a scheduler for every connector that has one missing.
 *
 * Schedulers live in Redis, connectors live in Postgres, and only one of those
 * is the source of truth. A Redis that comes up empty — a fresh deployment, a
 * wiped volume, a managed instance restarted without persistence — leaves the
 * connector rows intact and their polling silently gone: the interface goes on
 * showing a mailbox as idle, with a last-synced time that never advances, and
 * nothing reports an error because nothing failed. Reconciling at boot makes
 * Postgres authoritative.
 */
export async function reconcileMailboxSchedules(
  connectorIds: string[],
): Promise<{ restored: number }> {
  const existing = new Set(
    (await mailboxQueue.getJobSchedulers(0, -1, true)).map((scheduler) => scheduler.key),
  );

  let restored = 0;
  for (const connectorId of connectorIds) {
    if (existing.has(schedulerId(connectorId))) continue;
    await scheduleMailboxSync(connectorId);
    restored += 1;
  }

  return { restored };
}
