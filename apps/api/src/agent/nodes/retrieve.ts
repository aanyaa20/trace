import type { RetrievedChunk } from '@trace/contracts';
import { env } from '../../env.js';
import { toError } from '../../errors.js';
import { dedupeByBestScore, hybridSearch } from '../../retrieval/hybrid.js';
import type { AgentContext, AgentState } from '../state.js';
import { searchQuery } from './analyse.js';

/**
 * A page or slide the question names outright: "what does slide 3 say?",
 * "summarise page 12", "on p. 4". Such a question has almost no topical words
 * for semantic search to match — the location is the query — so it is looked
 * up by metadata as well. Deterministic; nothing is inferred.
 */
export function namedLocations(question: string): number[] {
  const found = new Set<number>();
  for (const match of question.matchAll(/\b(?:slide|page|pg\.?|p\.)\s*(\d{1,4})\b/gi)) {
    const value = Number(match[1]);
    if (value > 0) found.add(value);
  }
  return [...found].slice(0, 3);
}

/**
 * Runs every query in the plan against the hybrid index and merges the
 * results. Running the rewrites concurrently matters: they are independent,
 * and the loop may do this up to three times.
 */
export async function retrieve(state: AgentState, ctx: AgentContext): Promise<AgentState> {
  const stage = ctx.bus.begin('retrieve', state.iteration);

  // Agentic mode casts wider because the reranker narrows afterwards; naive
  // mode is the single-pass baseline and keeps its original candidate count.
  const width =
    state.mode === 'agentic' && env.RERANK_ENABLED ? env.RETRIEVAL_CANDIDATES : env.RETRIEVAL_TOP_K;

  try {
    const modalities = state.analysis?.modalityHints ?? [];
    const scope = {
      kbId: state.kbId,
      limit: width,
      ...(state.documentId ? { documentId: state.documentId } : {}),
    };
    const pages = namedLocations(searchQuery(state));
    // A modality hint adds a filtered search; it never replaces the open one.
    // As a hard filter it hid answers whenever the hint was wrong — "slide"
    // was read as "image", and a PowerPoint's slides are text, so every slide
    // was filtered out of "what does slide 3 say?".
    const [settled, hinted, located] = await Promise.all([
      Promise.all(state.queries.map((query) => hybridSearch({ ...scope, query }))),
      modalities.length > 0
        ? hybridSearch({ ...scope, query: searchQuery(state), modalities })
        : Promise.resolve(null),
      Promise.all(
        pages.map((page) => hybridSearch({ ...scope, query: searchQuery(state), page, limit: 6 })),
      ),
    ]);
    if (hinted) settled.push(hinted);

    const pinned = located.flatMap((result) => result.chunks);
    // Located chunks go first: the question named exactly where to look.
    const merged: RetrievedChunk[] = [...pinned, ...settled.flatMap((result) => result.chunks)];
    const candidateCount = settled.reduce((sum, result) => sum + result.candidateCount, 0);

    // Chunks already judged relevant in an earlier iteration are excluded, so
    // a second pass spends its grading budget on new evidence.
    const alreadyKept = new Set(state.relevant.map((chunk) => chunk.chunkId));
    const pinnedIds = new Set(pinned.map((chunk) => chunk.chunkId));
    const ranked = dedupeByBestScore(merged);
    const fresh = [
      ...ranked.filter((chunk) => pinnedIds.has(chunk.chunkId)),
      ...ranked.filter((chunk) => !pinnedIds.has(chunk.chunkId)),
    ]
      .filter((chunk) => !alreadyKept.has(chunk.chunkId))
      .slice(0, width);

    stage.complete({
      stage: 'retrieve',
      queries: state.queries,
      chunks: fresh,
      candidateCount,
    });

    return {
      ...state,
      candidates: fresh,
      reranked: false,
      retrievedCount: fresh.length,
      pinned: [...new Set([...state.pinned, ...pinnedIds])],
    };
  } catch (cause) {
    const message = toError(cause).message;
    stage.fail(message);
    return { ...state, candidates: [], reranked: false, retrievedCount: 0 };
  }
}
