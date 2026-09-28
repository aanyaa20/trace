import type { RetrievedChunk } from '@trace/contracts';
import { env } from '../../env.js';
import { toError } from '../../errors.js';
import { mlClient } from '../../services/ml.js';
import type { AgentContext, AgentState } from '../state.js';
import { searchQuery } from './analyse.js';

/** The cross-encoder reads query and passage together; past a few hundred
 *  words it truncates anyway, so there is no point shipping more. */
const MAX_CHARS_PER_PASSAGE = 2000;

/**
 * Orders the kept candidates by cross-encoder score and prunes them to
 * RERANK_TOP_K. Pure, so the pruning rule is testable without a model.
 *
 * Below RERANK_MIN_SCORE the model is sure a passage is noise and it is not
 * graded — except the top RERANK_MIN_KEEP, which the grader always sees.
 */
export function pruneReranked(
  candidates: RetrievedChunk[],
  scores: number[],
  limits: { topK: number; minScore: number; minKeep: number },
): { ordered: RetrievedChunk[]; kept: RetrievedChunk[] } {
  const ordered = candidates
    .map((chunk, index) => ({ ...chunk, rerankScore: scores[index] ?? 0 }))
    .sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
  // The best few always reach the grader, whatever the cross-encoder thought
  // of them. It is trained on web passages and reads tables and statistics
  // poorly — it scored a "mean 72" block 0.0099 for "what is the average
  // score?" — and the floor must not be able to hide the answer outright.
  const kept = ordered
    .filter((chunk, index) => index < limits.minKeep || (chunk.rerankScore ?? 0) >= limits.minScore)
    .slice(0, limits.topK);
  return { ordered, kept };
}

/**
 * Cross-encoder reranking between retrieval and grading.
 *
 * Retrieval casts wide — RETRIEVAL_CANDIDATES fused hits — because a relevant
 * passage ranked twentieth by vector similarity is still relevant. The
 * reranker, which reads each passage against the question, narrows that to
 * the few worth an LLM's attention. That is both better precision and far
 * fewer grading tokens, which is what a free-tier per-minute limit rations.
 *
 * It scores against the resolved question, so a follow-up ("why is it
 * useful?") is judged as the question it actually is.
 *
 * If the ml service cannot rerank, the candidates pass through in fused order,
 * trimmed to the same size: degraded ordering, never lost evidence.
 */
export async function rerank(state: AgentState, ctx: AgentContext): Promise<AgentState> {
  if (!env.RERANK_ENABLED || state.candidates.length === 0) return state;

  const stage = ctx.bus.begin('rerank', state.iteration);
  const query = searchQuery(state);

  try {
    const response = await mlClient.rerank({
      query,
      passages: state.candidates.map((chunk) => chunk.text.slice(0, MAX_CHARS_PER_PASSAGE)),
    });

    const pruned = pruneReranked(state.candidates, response.scores, {
      topK: env.RERANK_TOP_K,
      minScore: env.RERANK_MIN_SCORE,
      minKeep: env.RERANK_MIN_KEEP,
    });
    const { ordered } = pruned;
    // A chunk the question located by page or slide is graded regardless: the
    // cross-encoder has no way to know "slide 3" means this passage.
    const pinned = new Set(state.pinned);
    const kept = [
      ...ordered.filter((chunk) => pinned.has(chunk.chunkId)),
      ...pruned.kept.filter((chunk) => !pinned.has(chunk.chunkId)),
    ].slice(0, Math.max(env.RERANK_TOP_K, pinned.size));
    const keptIds = new Set(kept.map((chunk) => chunk.chunkId));

    stage.complete({
      stage: 'rerank',
      query,
      model: response.model,
      candidates: ordered.map((chunk) => ({
        chunkId: chunk.chunkId,
        filename: chunk.filename,
        page: chunk.page,
        tsStart: chunk.tsStart,
        fusedScore: chunk.score,
        rerankScore: chunk.rerankScore ?? 0,
        kept: keptIds.has(chunk.chunkId),
      })),
      keptCount: kept.length,
    });

    return { ...state, candidates: kept, reranked: true };
  } catch (cause) {
    stage.fail(`reranker unavailable, keeping fused order: ${toError(cause).message}`);
    return { ...state, candidates: state.candidates.slice(0, env.RERANK_TOP_K) };
  }
}
