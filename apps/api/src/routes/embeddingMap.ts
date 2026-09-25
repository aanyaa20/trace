import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { embeddingMapQuerySchema, type EmbeddingMap, type EmbeddingPoint } from '@trace/contracts';
import { db } from '../db/client.js';
import { chunks, knowledgeBases } from '../db/schema.js';
import { notFound } from '../errors.js';
import { COLLECTION, DENSE_VECTOR, qdrant } from '../qdrant/client.js';
import { pca3 } from '../retrieval/projection.js';
import { mlClient } from '../services/ml.js';

const params = z.object({ id: z.string().uuid() });

interface ScrolledPoint {
  id: string | number;
  vector?: Record<string, unknown> | number[] | null;
  payload?: Record<string, unknown> | null;
}

export default async function embeddingMapRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.requireAuth);

  /**
   * Projects every chunk vector to three dimensions for the visualiser.
   *
   * Unlike the reference implementation, which averages a document's chunks
   * into one point, each chunk is its own point: the interesting structure is
   * how a single document spreads across topics, and an average hides exactly
   * that. When a query is supplied it is embedded and projected through the
   * same basis, so its position is comparable rather than merely nearby.
   */
  app.get('/kb/:id/embedding-map', async (request) => {
    const { id: kbId } = params.parse(request.params);
    const { query, limit } = embeddingMapQuerySchema.parse(request.query);

    const [owned] = await db
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.userId, request.session.sub)));
    if (!owned) throw notFound('knowledge base');

    const scrolled = await qdrant.scroll(COLLECTION, {
      filter: { must: [{ key: 'kb_id', match: { value: kbId } }] },
      limit,
      with_payload: true,
      with_vector: [DENSE_VECTOR],
    });

    const points = (scrolled.points ?? []) as ScrolledPoint[];
    const vectors: number[][] = [];
    const ids: string[] = [];

    for (const point of points) {
      const named = point.vector as Record<string, number[]> | undefined;
      const dense = named?.[DENSE_VECTOR];
      if (Array.isArray(dense)) {
        vectors.push(dense);
        ids.push(String(point.id));
      }
    }

    if (vectors.length === 0) {
      return {
        points: [],
        queryPoint: null,
        method: 'pca3',
        explainedVariance: [0, 0, 0],
        totalChunks: 0,
      } satisfies EmbeddingMap;
    }

    // The query joins the matrix before fitting so it shares the basis rather
    // than being projected onto axes derived without it.
    const queryVector = query ? (await mlClient.embedQuery({ query, includeClip: false })).dense : null;
    const matrix = queryVector ? [...vectors, queryVector] : vectors;
    const projection = pca3(matrix);

    const rows = await db
      .select({
        id: chunks.id,
        documentId: chunks.documentId,
        modality: chunks.modality,
        text: chunks.text,
      })
      .from(chunks)
      .where(eq(chunks.kbId, kbId));
    const byId = new Map(rows.map((row) => [row.id, row]));

    const mapped: EmbeddingPoint[] = [];
    ids.forEach((id, index) => {
      const row = byId.get(id);
      const coordinate = projection.coordinates[index];
      if (!row || !coordinate) return;
      mapped.push({
        chunkId: id,
        documentId: row.documentId,
        filename: String(points[index]?.payload?.filename ?? ''),
        modality: row.modality,
        x: Number(coordinate[0]!.toFixed(4)),
        y: Number(coordinate[1]!.toFixed(4)),
        z: Number(coordinate[2]!.toFixed(4)),
        preview: row.text.slice(0, 160),
      });
    });

    const queryCoordinate = queryVector ? projection.coordinates[vectors.length] : undefined;

    const body: EmbeddingMap = {
      points: mapped,
      queryPoint: queryCoordinate
        ? {
            x: Number(queryCoordinate[0]!.toFixed(4)),
            y: Number(queryCoordinate[1]!.toFixed(4)),
            z: Number(queryCoordinate[2]!.toFixed(4)),
          }
        : null,
      method: 'pca3',
      explainedVariance: [
        projection.explainedVariance[0] ?? 0,
        projection.explainedVariance[1] ?? 0,
        projection.explainedVariance[2] ?? 0,
      ],
      totalChunks: mapped.length,
    };
    return body;
  });
}
