import type { RetrievalConfidence, RetrievedChunk, SufficiencyDecision } from '@trace/contracts';
import { env } from '../../env.js';
import type { AgentContext, AgentState } from '../state.js';

export interface SufficiencyThresholds {
  minRelevantChunks: number;
  /** Floor for a passage the LLM graded. */
  minScore: number;
  /** Floor for a passage only the reranker judged. The two scores are on
   *  different scales, so each is held to the threshold calibrated for it. */
  minRerankScore: number;
  /** Grader score at which one passage suffices, if the reranker agrees. */
  singleSourceScore: number;
  /** Reranker score at which one reranker-judged passage suffices. */
  singleSourceRerank: number;
}

/** The reranker's floor for agreeing that a single passage is decisive. */
const SINGLE_SOURCE_RERANK = 0.5;

export function thresholds(): SufficiencyThresholds {
  return {
    minRelevantChunks: env.SUFFICIENCY_MIN_RELEVANT_CHUNKS,
    minScore: env.SUFFICIENCY_MIN_SCORE,
    minRerankScore: env.RERANK_FALLBACK_MIN_SCORE,
    singleSourceScore: env.SUFFICIENCY_SINGLE_SOURCE_SCORE,
    singleSourceRerank: env.SUFFICIENCY_SINGLE_SOURCE_RERANK,
  };
}

/** A chart or table read from an image or scanned page. */
export function isDataRegion(chunk: RetrievedChunk): boolean {
  return chunk.visual?.type === 'chart' || chunk.visual?.type === 'table';
}

/**
 * Text that was read off a picture — OCR of a diagram or scan, a vision
 * model's description, any image region — rather than written as prose. The
 * cross-encoder is trained on prose and scores these fragments low however
 * well they answer: the architecture diagram, graded 0.95 for "what are the
 * stages of the pipeline in the architecture diagram", was vetoed by it.
 */
export function readFromImage(chunk: RetrievedChunk): boolean {
  return (
    isDataRegion(chunk) ||
    chunk.visual !== null ||
    chunk.modality === 'image' ||
    chunk.source === 'ocr' ||
    chunk.source === 'vision' ||
    chunk.source === 'caption'
  );
}

/** Whether one kept chunk clears the floor for whichever judge kept it. */
export function isStrong(chunk: RetrievedChunk, limits: SufficiencyThresholds): boolean {
  return chunk.gradedBy === 'rerank'
    ? chunk.score >= limits.minRerankScore
    : chunk.score >= limits.minScore;
}

/**
 * Retrieval confidence, from scores the pipeline actually produced. The mean
 * of the best three evidence scores, so one strong passage among noise reads
 * as moderate rather than certain; zero when nothing was kept.
 */
export function confidenceOf(state: AgentState): RetrievalConfidence {
  const scores = state.relevant.map((chunk) => chunk.score).sort((a, b) => b - a);
  const top = scores.slice(0, 3);
  const judges = new Set(state.relevant.map((chunk) => chunk.gradedBy ?? 'llm'));
  const clamp = (value: number): number => Math.max(0, Math.min(1, value));
  return {
    retrievalConfidence: top.length > 0 ? clamp(top.reduce((a, b) => a + b, 0) / top.length) : 0,
    topScore: clamp(scores[0] ?? 0),
    candidateCount: state.retrievedCount,
    rerankedCount: state.candidates.length,
    evidenceCount: state.relevant.length,
    basis: judges.size === 0 ? 'none' : judges.size > 1 ? 'mixed' : judges.has('rerank') ? 'rerank' : 'llm',
  };
}

/**
 * The gate is deliberately deterministic. It is the single knob the
 * evaluation chapter sweeps to plot false-answer rate against
 * over-abstention rate, and a sweep is only meaningful if the same inputs
 * always produce the same decision. Putting an LLM here would make every
 * point on that curve a distribution instead of a value.
 */
export function decide(state: AgentState, limits: SufficiencyThresholds): {
  decision: SufficiencyDecision;
  rationale: string;
} {
  const strong = state.relevant.filter((chunk) => isStrong(chunk, limits));
  const evidence = strong.length + state.external.length;

  // A question asked about one open document is already narrowed by the
  // reader. Requiring two corroborating passages from a single file rules out
  // every short one — a one-page scan, a photographed slide, a mail with two
  // lines in it — which would have nothing to say about itself no matter how
  // squarely the evidence answered the question. The score floor is untouched:
  // the passage still has to be relevant, there just has to be one of it.
  const minimum = state.documentId ? 1 : limits.minRelevantChunks;

  // A decisive single passage: both judges independently rate it highly. The
  // corroboration rule exists to stop one weakly-relevant passage carrying an
  // answer; it was also refusing every fact the corpus states exactly once.
  // With the grader unavailable, a reranker-only verdict can be decisive too,
  // but only near certainty: on the calibration set every relevant passage
  // scored 0.99+ and every trap, off-topic and unsupported pair 0.00-0.03.
  //
  // Text read from an image — a chart or table region above all — is exempt
  // from the reranker's agreement. The
  // cross-encoder is trained on prose passages and scores a grid of numbers
  // poorly however well it answers: the correct market-size chart scored 0.22
  // for "which year was highest" while the grader, reading it, gave 0.9. Its
  // veto there measured the format, not the relevance.
  const decisive = strong.find((chunk) =>
    chunk.gradedBy === 'rerank'
      ? chunk.score >= limits.singleSourceRerank
      : chunk.score >= limits.singleSourceScore &&
        (chunk.rerankScore === null ||
          chunk.rerankScore >= SINGLE_SOURCE_RERANK ||
          readFromImage(chunk)),
  );
  // The question named the page or slide, retrieval went there by metadata,
  // and the grader confirmed the passage answers it: that is the evidence.
  const located = strong.find((chunk) => state.pinned.includes(chunk.chunkId));
  if (evidence < minimum && located) {
    return {
      decision: 'answer',
      rationale: `the question named ${located.page !== null ? `page/slide ${located.page}` : 'a location'}; the passage retrieved there (${located.filename}) was graded ${located.score.toFixed(2)}`,
    };
  }

  if (evidence < minimum && decisive) {
    return {
      decision: 'answer',
      rationale: `one passage (${decisive.filename}) was graded ${decisive.score.toFixed(2)}${
        decisive.rerankScore !== null ? ` and reranked ${decisive.rerankScore.toFixed(2)}` : ''
      }, at or above the single-source bar of ${limits.singleSourceScore}; a fact stated once is still stated`,
    };
  }

  if (evidence >= minimum) {
    return {
      decision: 'answer',
      rationale: `${strong.length} corpus chunks scored at or above ${limits.minScore}${
        state.external.length > 0 ? ` plus ${state.external.length} external results` : ''
      }, which meets the minimum of ${minimum}${
        state.documentId ? ' for a question scoped to one document' : ''
      }`,
    };
  }

  if (state.iteration < env.AGENT_MAX_ITERATIONS) {
    return {
      decision: 'retry',
      rationale: `only ${strong.length} chunks cleared ${limits.minScore}; retrying with reformulated queries (iteration ${state.iteration} of ${env.AGENT_MAX_ITERATIONS})`,
    };
  }

  if (env.WEB_SEARCH_PROVIDER !== 'none' && !state.webSearched) {
    return {
      decision: 'web_fallback',
      rationale: `the corpus yielded ${strong.length} usable chunks after ${state.iteration} iterations; falling back to web search, whose results are labelled external`,
    };
  }

  return {
    decision: 'abstain',
    rationale: `after ${state.iteration} iterations the corpus yielded ${strong.length} chunks at or above ${limits.minScore}, below the minimum of ${minimum}`,
  };
}

export async function sufficiency(state: AgentState, ctx: AgentContext): Promise<AgentState> {
  const stage = ctx.bus.begin('sufficiency', state.iteration);
  const limits = thresholds();
  const { decision, rationale } = decide(state, limits);

  stage.complete({
    stage: 'sufficiency',
    decision,
    rationale,
    relevantCount: state.relevant.length,
    thresholds: { minRelevantChunks: limits.minRelevantChunks, minScore: limits.minScore },
    confidence: confidenceOf(state),
  });

  return { ...state, decision };
}
