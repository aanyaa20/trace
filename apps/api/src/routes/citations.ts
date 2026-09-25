import { and, between, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ResolvedCitation } from '@trace/contracts';
import { db } from '../db/client.js';
import { chunks, documents, knowledgeBases } from '../db/schema.js';
import { notFound } from '../errors.js';

const params = z.object({ id: z.string().uuid() });
const NEIGHBOURS = 1;

export default async function citationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.requireAuth);

  /**
   * Full context behind one citation. The sources panel shows the neighbouring
   * chunks too, because a span read in isolation is easy to misjudge and the
   * point of a citation is that the user can check it.
   */
  app.get('/citations/:id/resolve', async (request) => {
    const { id } = params.parse(request.params);

    const [row] = await db
      .select({ chunk: chunks, document: documents, ownerId: knowledgeBases.userId })
      .from(chunks)
      .innerJoin(documents, eq(documents.id, chunks.documentId))
      .innerJoin(knowledgeBases, eq(knowledgeBases.id, chunks.kbId))
      .where(eq(chunks.id, id));

    if (!row || row.ownerId !== request.session.sub) throw notFound('citation');

    const neighbours = await db
      .select({ ordinal: chunks.ordinal, text: chunks.text })
      .from(chunks)
      .where(
        and(
          eq(chunks.documentId, row.chunk.documentId),
          between(chunks.ordinal, row.chunk.ordinal - NEIGHBOURS, row.chunk.ordinal + NEIGHBOURS),
        ),
      )
      .orderBy(chunks.ordinal);

    const previewUrl =
      row.chunk.page !== null
        ? `/documents/${row.chunk.documentId}/preview?page=${row.chunk.page}`
        : `/documents/${row.chunk.documentId}/preview`;

    const body: ResolvedCitation = {
      marker: 0,
      chunkId: row.chunk.id,
      documentId: row.chunk.documentId,
      filename: row.document.filename,
      modality: row.chunk.modality,
      source: row.chunk.source,
      page: row.chunk.page,
      charStart: row.chunk.charStart,
      charEnd: row.chunk.charEnd,
      tsStart: row.chunk.tsStart,
      tsEnd: row.chunk.tsEnd,
      imagePath: row.chunk.imagePath,
      snippet: row.chunk.text.slice(0, 280),
      external: false,
      externalUrl: null,
      context: neighbours.map((neighbour) => neighbour.text).join('\n\n'),
      previewUrl,
    };
    return body;
  });
}
