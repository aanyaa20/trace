import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  createKnowledgeBaseRequestSchema,
  type KnowledgeBase,
  type KnowledgeBaseList,
} from '@trace/contracts';
import { db } from '../db/client.js';
import { documents, knowledgeBases } from '../db/schema.js';
import { notFound } from '../errors.js';

const idParamsSchema = z.object({ id: z.string().uuid() });

export default async function kbRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.requireAuth);

  app.get('/kb', async (request) => {
    const rows = await db
      .select({
        id: knowledgeBases.id,
        userId: knowledgeBases.userId,
        name: knowledgeBases.name,
        description: knowledgeBases.description,
        createdAt: knowledgeBases.createdAt,
        documentCount: count(documents.id),
      })
      .from(knowledgeBases)
      .leftJoin(documents, eq(documents.kbId, knowledgeBases.id))
      .where(eq(knowledgeBases.userId, request.session.sub))
      .groupBy(knowledgeBases.id)
      .orderBy(desc(knowledgeBases.createdAt));

    const body: KnowledgeBaseList = {
      knowledgeBases: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        name: row.name,
        description: row.description,
        documentCount: Number(row.documentCount),
        createdAt: row.createdAt.toISOString(),
      })),
    };
    return body;
  });

  app.post('/kb', async (request, reply) => {
    const { name, description } = createKnowledgeBaseRequestSchema.parse(request.body);

    const [created] = await db
      .insert(knowledgeBases)
      .values({ userId: request.session.sub, name, description: description ?? null })
      .returning();

    if (!created) throw notFound('knowledge base');

    const body: KnowledgeBase = {
      id: created.id,
      userId: created.userId,
      name: created.name,
      description: created.description,
      documentCount: 0,
      createdAt: created.createdAt.toISOString(),
    };
    return reply.status(201).send(body);
  });

  app.delete('/kb/:id', async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);

    // Documents, chunks, conversations and messages cascade in Postgres. The
    // matching Qdrant points are removed by the ingestion module in phase 1,
    // which owns every write to the collection.
    const deleted = await db
      .delete(knowledgeBases)
      .where(and(eq(knowledgeBases.id, id), eq(knowledgeBases.userId, request.session.sub)))
      .returning({ id: knowledgeBases.id });

    if (deleted.length === 0) throw notFound('knowledge base');
    return reply.status(204).send();
  });
}
