import type { IngestionEvent } from '@trace/contracts';
import { createRedis, redis } from '../queue/connection.js';
import { logger } from '../logger.js';
import { toError } from '../errors.js';

/**
 * Ingestion progress is produced by the worker process and consumed by the api
 * process, so the bus has to cross a process boundary. Redis pub/sub is
 * fire-and-forget, which is the right semantic: a client that connects late
 * has missed nothing important, because document status is also persisted.
 */
const channel = (kbId: string): string => `ingestion:${kbId}`;

export async function publishIngestionEvent(event: IngestionEvent): Promise<void> {
  try {
    await redis.publish(channel(event.kbId), JSON.stringify(event));
  } catch (cause) {
    // Losing a progress frame must never fail the ingestion it describes.
    logger.warn(
      { err: toError(cause), documentId: event.documentId },
      'could not publish ingestion event',
    );
  }
}

export interface IngestionSubscription {
  close(): Promise<void>;
}

export async function subscribeToIngestion(
  kbId: string,
  onEvent: (event: IngestionEvent) => void,
): Promise<IngestionSubscription> {
  const subscriber = createRedis();
  await subscriber.subscribe(channel(kbId));

  subscriber.on('message', (_channel, payload) => {
    try {
      onEvent(JSON.parse(payload) as IngestionEvent);
    } catch (cause) {
      logger.warn({ err: toError(cause), kbId }, 'could not parse ingestion event');
    }
  });

  return {
    close: async () => {
      await subscriber.unsubscribe(channel(kbId)).catch(() => undefined);
      subscriber.disconnect();
    },
  };
}
