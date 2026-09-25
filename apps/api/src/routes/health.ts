import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { env } from '../env.js';
import { ollamaAvailable } from '../llm/ollama.js';
import { COLLECTION, qdrant } from '../qdrant/client.js';
import { mlClient } from '../services/ml.js';
import { toError } from '../errors.js';

type DependencyState = 'ok' | 'degraded' | 'unreachable';

interface DependencyReport {
  state: DependencyState;
  detail?: string;
}

async function probe(check: () => Promise<DependencyReport>): Promise<DependencyReport> {
  try {
    return await check();
  } catch (cause) {
    return { state: 'unreachable', detail: toError(cause).message };
  }
}

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  /** Liveness only. Must not touch a dependency, or a slow Qdrant would make
   *  the orchestrator kill a healthy api. */
  app.get('/healthz', async () => ({ status: 'ok', service: 'api', uptimeSec: process.uptime() }));

  app.get('/readyz', async (_request, reply) => {
    const [postgres, vectors, ml, fallback] = await Promise.all([
      probe(async () => {
        await db.execute(sql`select 1`);
        return { state: 'ok' };
      }),
      probe(async () => {
        const info = await qdrant.getCollection(COLLECTION);
        return { state: 'ok', detail: `${info.points_count ?? 0} points` };
      }),
      probe(async () => {
        const health = await mlClient.health();
        const loaded = Object.entries(health.models)
          .filter(([, state]) => state === 'loaded')
          .map(([name]) => name);
        return {
          state: health.status === 'ok' ? 'ok' : 'degraded',
          detail: loaded.length > 0 ? `loaded: ${loaded.join(', ')}` : 'no models warm yet',
        };
      }),
      // Reported so a fallback that is configured but not running is visible
      // before the quota runs out rather than at the moment it is needed.
      probe(async (): Promise<DependencyReport> => {
        if (env.LLM_FALLBACK_PROVIDER === 'none') {
          return { state: 'ok', detail: 'not configured' };
        }
        const reachable = await ollamaAvailable();
        return reachable
          ? { state: 'ok', detail: `${env.OLLAMA_MODEL} / ${env.OLLAMA_FAST_MODEL}` }
          : {
              state: 'degraded',
              detail: `configured but ${env.OLLAMA_URL} is unreachable; a quota wall will fail instead of degrading`,
            };
      }),
    ]);

    // A cold ml service is expected on first boot and must not fail readiness;
    // only postgres and qdrant are hard requirements for serving traffic.
    const ready = postgres.state === 'ok' && vectors.state === 'ok';
    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      dependencies: { postgres, qdrant: vectors, ml, llmFallback: fallback },
    });
  });
}
