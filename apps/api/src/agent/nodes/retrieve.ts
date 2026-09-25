import type { RetrievedChunk } from '@trace/contracts';
import { env } from '../../env.js';
import { toError } from '../../errors.js';
import { dedupeByBestScore, hybridSearch } from '../../retrieval/hybrid.js';
import type { AgentContext, AgentState } from '../state.js';

/**
 * Runs every query in the plan against the hybrid index and merges the
 * results. Running the rewrites concurrently matters: they are independent,
 * and the loop may do this up to three times.
 */
export async function retrieve(state: AgentState, ctx: AgentContext): Promise<AgentState> {
  const stage = ctx.bus.begin('retrieve', state.iteration);

  try {
    const modalities = state.analysis?.modalityHints ?? [];
    const settled = await Promise.all(
      state.queries.map((query) =>
        hybridSearch({
          kbId: state.kbId,
          query,
          limit: env.RETRIEVAL_TOP_K,
          ...(modalities.length > 0 ? { modalities } : {}),
          ...(state.documentId ? { documentId: state.documentId } : {}),
        }),
      ),
    );

    const merged: RetrievedChunk[] = settled.flatMap((result) => result.chunks);
    const candidateCount = settled.reduce((sum, result) => sum + result.candidateCount, 0);

    // Chunks already judged relevant in an earlier iteration are excluded, so
    // a second pass spends its grading budget on new evidence.
    const alreadyKept = new Set(state.relevant.map((chunk) => chunk.chunkId));
    const fresh = dedupeByBestScore(merged)
      .filter((chunk) => !alreadyKept.has(chunk.chunkId))
      .slice(0, env.RETRIEVAL_TOP_K);

    stage.complete({
      stage: 'retrieve',
      queries: state.queries,
      chunks: fresh,
      candidateCount,
    });

    return { ...state, candidates: fresh };
  } catch (cause) {
    const message = toError(cause).message;
    stage.fail(message);
    return { ...state, candidates: [] };
  }
}
