import { eq, inArray } from 'drizzle-orm';
import type { Modality, RegionType, RetrievedChunk } from '@trace/contracts';
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
  /** Restricts the search to these documents: a mail and its attachments. */
  documentIds?: string[];
  /** Restricts the search to one page or slide number ("what does slide 3 say?"). */
  page?: number;
  /** Restricts the search to regions of these types: charts, tables, photos. */
  regionTypes?: RegionType[];
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

/** Rank within one branch, 1-based. */
interface BranchHit {
  rank: number;
}

/**
 * Weighted reciprocal-rank fusion: each branch contributes weight / (k + rank)
 * for every point it returned. Ranks, not raw scores, because a cosine
 * similarity and a BM25 score are on unrelated scales and adding them would
 * let whichever is numerically larger decide. With equal weights this is
 * standard RRF; raising the sparse weight favours exact terms — codes, names,
 * section numbers — for a corpus full of them.
 */
export function weightedRrf(
  dense: Array<string | number>,
  sparse: Array<string | number>,
  weights: { dense: number; sparse: number; k: number },
): Array<{ id: string; score: number; dense: BranchHit | null; sparse: BranchHit | null }> {
  const fused = new Map<string, { score: number; dense: BranchHit | null; sparse: BranchHit | null }>();
  const add = (ids: Array<string | number>, weight: number, branch: 'dense' | 'sparse'): void => {
    ids.forEach((raw, index) => {
      const id = String(raw);
      const entry = fused.get(id) ?? { score: 0, dense: null, sparse: null };
      entry.score += weight / (weights.k + index + 1);
      entry[branch] = { rank: index + 1 };
      fused.set(id, entry);
    });
  };
  add(dense, weights.dense, 'dense');
  add(sparse, weights.sparse, 'sparse');
  return [...fused.entries()]
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => b.score - a.score);
}

/**
 * One hybrid query. Both branches — dense semantic vectors and BM25 sparse
 * vectors — are sent to Qdrant in a single batch request, then fused here with
 * configurable weights (weightedRrf). Qdrant's own server-side RRF has no
 * weights, and exact-match questions ("what is TB-2048?") need BM25 to be able
 * to outvote a semantically similar but wrong passage.
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
      ...(request.documentIds && request.documentIds.length > 0
        ? [{ key: 'document_id', match: { any: request.documentIds } }]
        : request.documentId
          ? [{ key: 'document_id', match: { value: request.documentId } }]
          : []),
      ...(request.page !== undefined ? [{ key: 'page', match: { value: request.page } }] : []),
      ...(request.regionTypes && request.regionTypes.length > 0
        ? [{ key: 'region_type', match: { any: request.regionTypes } }]
        : []),
    ],
  };

  let denseHits: QdrantPoint[];
  let sparseHits: QdrantPoint[];
  try {
    const [dense, sparse] = await qdrant.queryBatch(COLLECTION, {
      searches: [
        { query: embedded.dense, using: DENSE_VECTOR, filter, limit: prefetchLimit, with_payload: true },
        {
          query: { indices: embedded.sparse.indices, values: embedded.sparse.values },
          using: SPARSE_VECTOR,
          filter,
          limit: prefetchLimit,
          with_payload: true,
        },
      ],
    });
    denseHits = (dense?.points ?? []) as QdrantPoint[];
    sparseHits = (sparse?.points ?? []) as QdrantPoint[];
  } catch (cause) {
    throw upstreamFailure('qdrant', `hybrid query failed: ${String(cause)}`);
  }

  const payloadById = new Map<string, QdrantPoint>();
  for (const point of [...denseHits, ...sparseHits]) payloadById.set(String(point.id), point);

  const fused = weightedRrf(
    denseHits.map((point) => point.id),
    sparseHits.map((point) => point.id),
    { dense: env.HYBRID_DENSE_WEIGHT, sparse: env.HYBRID_SPARSE_WEIGHT, k: env.HYBRID_RRF_K },
  ).slice(0, limit);

  const response = {
    points: fused.map((entry) => ({
      id: entry.id,
      score: entry.score,
      payload: payloadById.get(entry.id)?.payload ?? null,
    })),
  };

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
      section: row.section,
      external: false,
      externalUrl: null,
      rerankScore: null,
      gradedBy: null,
      visual: row.visual ?? null,
    });
  }

  // Unique points either branch returned, before fusion trimmed them.
  return { chunks: hydrated, candidateCount: payloadById.size };
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
