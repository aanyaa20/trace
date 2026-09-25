import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { knowledgeBases } from '../db/schema.js';
import { notFound } from '../errors.js';
import { subscribeToIngestion } from '../events/ingestionBus.js';
import { SseStream } from '../services/sse.js';

const params = z.object({ kbId: z.string().uuid() });
const HEARTBEAT_MS = 25_000;

export default async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.requireAuth);

  app.get('/events/ingestion/:kbId', async (request, reply) => {
    const { kbId } = params.parse(request.params);

    const [owned] = await db
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.userId, request.session.sub)));
    if (!owned) throw notFound('knowledge base');

    const stream = new SseStream(reply);
    const subscription = await subscribeToIngestion(kbId, (event) => {
      stream.send('ingestion', event);
    });

    const heartbeat = setInterval(() => stream.comment('keepalive'), HEARTBEAT_MS);

    stream.onClientDisconnect(() => {
      clearInterval(heartbeat);
      void subscription.close();
    });

    // Returning the reply would let Fastify end the response; the stream stays
    // open until the client disconnects.
    return reply;
  });
}
