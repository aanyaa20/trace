import { eq, inArray } from 'drizzle-orm';
import type { Modality, RetrievedChunk } from '@trace/contracts';
import { db } from '../db/client.js';
import { chunks } from '../db/schema.js';
import { env } from '../env.js';
import { upstreamFailure } from '../errors.js';
import { COLLECTION, DENSE_VECTOR, SPARSE_VECTOR, qdrant } from '../qdrant/client.js';
import { mlClient } from '../services/ml.js';

export interface HybridQuery {
  kbId: string;
  query: string;
  limit?: number;
  /** Restricts the search to these modalities when the analyser inferred one. */
  modalities?: Modality[];
  /** Restricts the search to one document, for a question asked about it. */
  documentId?: string;
}

export interface HybridResult {
  chunks: RetrievedChunk[];
  /** Candidates each branch contributed before fusion, for the trace. */
  candidateCount: number;
}

interface QdrantPoint {
  id: string | number;
  score: number;
  payload?: Record<string, unknown> | null;
}

/**
 * One hybrid query: dense and BM25 branches are prefetched in parallel by
 * Qdrant and reciprocal-rank fused server-side. Fusing in Node would mean
 * pulling both candidate lists over the wire only to re-sort them, and would
 * hide a scoring decision in application code.
 */
export async function hybridSearch(request: HybridQuery): Promise<HybridResult> {
  const limit = request.limit ?? env.RETRIEVAL_TOP_K;
  const prefetchLimit = Math.max(env.RETRIEVAL_PREFETCH_K, limit);

  const embedded = await mlClient.embedQuery({ query: request.query, includeClip: false });

  const filter = {
    must: [
      { key: 'kb_id', match: { value: request.kbId } },
      ...(request.modalities && request.modalities.length > 0
        ? [{ key: 'modality', match: { any: request.modalities } }]
        : []),
      ...(request.documentId ? [{ key: 'document_id', match: { value: request.documentId } }] : []),
    ],
  };

  let response;
  try {
    response = await qdrant.query(COLLECTION, {
      prefetch: [
        { query: embedded.dense, using: DENSE_VECTOR, filter, limit: prefetchLimit },
        {
          query: { indices: embedded.sparse.indices, values: embedded.sparse.values },
          using: SPARSE_VECTOR,
          filter,
          limit: prefetchLimit,
        },
      ],
      query: { fusion: 'rrf' },
      limit,
      with_payload: true,
    });
  } catch (cause) {
    throw upstreamFailure('qdrant', `hybrid query failed: ${String(cause)}`);
  }

  const points = (response.points ?? []) as QdrantPoint[];
  if (points.length === 0) return { chunks: [], candidateCount: 0 };

  // Qdrant holds a preview; the full text and the exact locator live in
  // Postgres, and the answer is only as good as the text the model reads.
  const ids = points.map((point) => String(point.id));
  const rows = await db.select().from(chunks).where(inArray(chunks.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));

  const hydrated: RetrievedChunk[] = [];
  for (const point of points) {
    const row = byId.get(String(point.id));
    // A vector whose row is gone is an orphan from an interrupted ingestion.
    // Dropping it is correct: nothing can be cited from a chunk that no
    // longer exists.
    if (!row) continue;

    hydrated.push({
      chunkId: row.id,
      documentId: row.documentId,
      filename: String(point.payload?.filename ?? ''),
      modality: row.modality,
      source: row.source,
      text: row.text,
      score: point.score,
      page: row.page,
      charStart: row.charStart,
      charEnd: row.charEnd,
      tsStart: row.tsStart,
      tsEnd: row.tsEnd,
      imagePath: row.imagePath,
      external: false,
      externalUrl: null,
    });
  }

  return { chunks: hydrated, candidateCount: points.length };
}

/** Merges results from several rewrites, keeping each chunk's best rank. */
export function dedupeByBestScore(results: RetrievedChunk[]): RetrievedChunk[] {
  const best = new Map<string, RetrievedChunk>();
  for (const chunk of results) {
    const existing = best.get(chunk.chunkId);
    if (!existing || chunk.score > existing.score) best.set(chunk.chunkId, chunk);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

export async function countChunksInKb(kbId: string): Promise<number> {
  const rows = await db.select({ id: chunks.id }).from(chunks).where(eq(chunks.kbId, kbId));
  return rows.length;
}
