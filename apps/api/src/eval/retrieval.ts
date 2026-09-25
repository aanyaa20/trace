import type { EvalItem } from './dataset.js';
import { hybridSearch } from '../retrieval/hybrid.js';
import {
  hitAtK,
  mean,
  precisionAtK,
  reciprocalRank,
  recallAtK,
  type RankedItem,
} from './metrics.js';

export interface RetrievalOutcome {
  item: EvalItem;
  ranked: RankedItem[];
  latencyMs: number;
  scores: { precision: number; recall: number; hit: number; reciprocalRank: number };
}

export interface RetrievalReport {
  k: number;
  outcomes: RetrievalOutcome[];
  metrics: Record<string, number>;
}

/**
 * The retrieval stage costs no LLM quota.
 *
 * Embedding a query goes to the local ML service, and fusion happens inside
 * Qdrant, so this can be run as often as you like — which matters, because the
 * answer stage cannot. Every threshold and ranking change should be measured
 * here first; the expensive stage is for confirming that better retrieval
 * actually produced better answers.
 */
export async function runRetrieval(
  kbId: string,
  items: EvalItem[],
  k: number,
): Promise<RetrievalReport> {
  const outcomes: RetrievalOutcome[] = [];

  for (const item of items) {
    // An unanswerable question has nothing to retrieve correctly, so ranking
    // metrics over it would be noise. It is the answer stage that judges those.
    if (item.unanswerable) continue;

    const started = Date.now();
    const result = await hybridSearch({ kbId, query: item.question, limit: k });
    const latencyMs = Date.now() - started;

    const ranked: RankedItem[] = result.chunks.map((chunk) => ({
      filename: chunk.filename,
      page: chunk.page,
    }));

    const label = { relevantDocuments: item.relevantDocuments, relevantPages: item.relevantPages };

    outcomes.push({
      item,
      ranked,
      latencyMs,
      scores: {
        precision: precisionAtK(ranked, label, k),
        recall: recallAtK(ranked, label, k),
        hit: hitAtK(ranked, label, k),
        reciprocalRank: reciprocalRank(ranked, label),
      },
    });
  }

  return {
    k,
    outcomes,
    metrics: {
      questions: outcomes.length,
      [`precision@${k}`]: mean(outcomes.map((outcome) => outcome.scores.precision)),
      [`recall@${k}`]: mean(outcomes.map((outcome) => outcome.scores.recall)),
      [`hit@${k}`]: mean(outcomes.map((outcome) => outcome.scores.hit)),
      mrr: mean(outcomes.map((outcome) => outcome.scores.reciprocalRank)),
      medianLatencyMs: median(outcomes.map((outcome) => outcome.latencyMs)),
    },
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}
