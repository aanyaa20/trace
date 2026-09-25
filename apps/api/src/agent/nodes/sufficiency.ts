import type { SufficiencyDecision } from '@trace/contracts';
import { env } from '../../env.js';
import type { AgentContext, AgentState } from '../state.js';

export interface SufficiencyThresholds {
  minRelevantChunks: number;
  minScore: number;
}

export function thresholds(): SufficiencyThresholds {
  return {
    minRelevantChunks: env.SUFFICIENCY_MIN_RELEVANT_CHUNKS,
    minScore: env.SUFFICIENCY_MIN_SCORE,
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
  const strong = state.relevant.filter((chunk) => chunk.score >= limits.minScore);
  const evidence = strong.length + state.external.length;

  // A question asked about one open document is already narrowed by the
  // reader. Requiring two corroborating passages from a single file rules out
  // every short one — a one-page scan, a photographed slide, a mail with two
  // lines in it — which would have nothing to say about itself no matter how
  // squarely the evidence answered the question. The score floor is untouched:
  // the passage still has to be relevant, there just has to be one of it.
  const minimum = state.documentId ? 1 : limits.minRelevantChunks;

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
  });

  return { ...state, decision };
}
