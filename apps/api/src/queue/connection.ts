import { Redis, type RedisOptions } from 'ioredis';
import { env } from '../env.js';

// BullMQ blocks on BRPOPLPUSH, so a request retry limit would abort the
// worker's long poll. Null is the setting BullMQ documents for its own
// connections.
const BULLMQ_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

export function createRedis(options: RedisOptions = {}): Redis {
  return new Redis(env.REDIS_URL, { ...BULLMQ_OPTIONS, ...options });
}

/** Shared by producers. Subscribers need their own connection, because a
 *  client in subscriber mode cannot issue ordinary commands. */
export const redis: Redis = createRedis();

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
