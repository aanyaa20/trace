import { eq } from 'drizzle-orm';
import type { AgentTrace, Citation, RetrievalMode } from '@trace/contracts';
import { runAgent } from '../agent/graph.js';
import { db } from '../db/client.js';
import { evalResults, evalRuns } from '../db/schema.js';
import { env } from '../env.js';
import { isDailyQuotaExhausted } from '../llm/rateLimiter.js';
import { logger } from '../logger.js';
import { toError } from '../errors.js';
import type { EvalItem } from './dataset.js';
import { abstentionRates, mean, scoreAnswer, type AnswerScores } from './metrics.js';

export interface AnswerOutcome {
  item: EvalItem;
  mode: RetrievalMode;
  answer: string;
  abstained: boolean;
  citations: Citation[];
  unresolvedCitations: number;
  scores: AnswerScores;
  latencyMs: number;
  trace: AgentTrace | null;
}

export interface AnswerReport {
  runId: string;
  mode: RetrievalMode;
  outcomes: AnswerOutcome[];
  metrics: Record<string, number>;
  /** True when the run stopped early on an exhausted daily quota. */
  partial: boolean;
  remaining: string[];
}

/** Markers the model emitted that the resolver refused. The agent already
 *  reports this; the eval reads it rather than recomputing it. */
function unresolvedFrom(trace: AgentTrace | null): number {
  if (!trace) return 0;
  let rejected = 0;
  for (const event of trace.events) {
    if (event.payload?.stage === 'citations') rejected = event.payload.rejectedMarkers.length;
  }
  return rejected;
}

/**
 * The expensive stage: one full agent run per question, three to five LLM
 * requests each.
 *
 * On the free tier that is a handful of questions a day, so this is built to be
 * interrupted. Every question is written to eval_results the moment it finishes,
 * and an exhausted daily quota stops the run and reports what was completed
 * rather than throwing away the work already paid for. `--resume` picks up the
 * same run the next day.
 */
export async function runAnswers(
  kbId: string,
  dataset: string,
  items: EvalItem[],
  mode: RetrievalMode,
  options: { resumeRunId?: string; notes?: string } = {},
): Promise<AnswerReport> {
  let runId = options.resumeRunId;
  let done = new Set<string>();

  if (runId) {
    const [run] = await db.select().from(evalRuns).where(eq(evalRuns.id, runId));
    if (!run) throw new Error(`eval run ${runId} not found`);
    if (run.mode !== mode) throw new Error(`eval run ${runId} is a ${run.mode} run, not ${mode}`);
    const previous = await db
      .select({ question: evalResults.question })
      .from(evalResults)
      .where(eq(evalResults.runId, runId));
    done = new Set(previous.map((row) => row.question));
  } else {
    const [created] = await db
      .insert(evalRuns)
      .values({
        kbId,
        dataset,
        mode,
        ...(options.notes ? { notes: options.notes } : {}),
        // The sweep is only reproducible if a run records the thresholds it
        // was measured under, not just its scores.
        config: {
          SUFFICIENCY_MIN_SCORE: env.SUFFICIENCY_MIN_SCORE,
          SUFFICIENCY_MIN_RELEVANT_CHUNKS: env.SUFFICIENCY_MIN_RELEVANT_CHUNKS,
          AGENT_MAX_ITERATIONS: env.AGENT_MAX_ITERATIONS,
          RETRIEVAL_TOP_K: env.RETRIEVAL_TOP_K,
          RETRIEVAL_PREFETCH_K: env.RETRIEVAL_PREFETCH_K,
          GEMINI_MODEL: env.GEMINI_MODEL,
          GEMINI_FAST_MODEL: env.GEMINI_FAST_MODEL,
        },
      })
      .returning({ id: evalRuns.id });
    runId = created!.id;
  }

  const outcomes: AnswerOutcome[] = [];
  const remaining: string[] = [];
  let partial = false;

  for (const item of items) {
    if (partial) {
      remaining.push(item.id);
      continue;
    }
    if (done.has(item.question)) continue;

    const controller = new AbortController();
    const started = Date.now();

    try {
      const result = await runAgent({
        kbId,
        query: item.question,
        mode,
        signal: controller.signal,
        onEvent: () => undefined,
        onToken: () => undefined,
      });

      const latencyMs = Date.now() - started;
      const citedDocuments = result.citations.map((citation) => citation.filename);
      const unresolvedCitations = unresolvedFrom(result.trace);

      const scores = scoreAnswer(
        {
          abstained: result.abstained,
          answer: result.answer,
          citedDocuments,
          unresolvedCitations,
          totalCitations: result.citations.length,
        },
        {
          relevantDocuments: item.relevantDocuments,
          expectAnswerContains: item.expectAnswerContains,
          unanswerable: item.unanswerable,
        },
      );

      // Written before the next question runs. A crash or a quota wall then
      // costs the question in flight, not the whole run.
      await db.insert(evalResults).values({
        runId,
        question: item.question,
        expected: item.relevantDocuments.join(', ') || (item.unanswerable ? 'abstention' : null),
        answer: result.answer,
        abstained: result.abstained,
        citations: result.citations,
        scores: { ...scores, latencyMs, iterations: result.trace.iterations },
        latencyMs,
      });

      outcomes.push({
        item,
        mode,
        answer: result.answer,
        abstained: result.abstained,
        citations: result.citations,
        unresolvedCitations,
        scores,
        latencyMs,
        trace: result.trace,
      });

      logger.info(
        { id: item.id, mode, abstained: result.abstained, ms: latencyMs },
        'eval question complete',
      );
    } catch (cause) {
      if (isDailyQuotaExhausted(cause)) {
        // Waiting cannot clear a daily allowance, so the run stops rather than
        // burning the remaining questions on certain failures.
        partial = true;
        remaining.push(item.id);
        logger.warn({ id: item.id }, 'daily quota exhausted; stopping and keeping partial results');
        continue;
      }
      throw toError(cause);
    }
  }

  const rates = abstentionRates(
    outcomes.map((outcome) => ({
      unanswerable: outcome.item.unanswerable,
      abstained: outcome.abstained,
    })),
  );

  const metrics: Record<string, number> = {
    questions: outcomes.length,
    abstentionAccuracy: mean(outcomes.map((outcome) => outcome.scores.abstentionCorrect)),
    citationPrecision: mean(outcomes.map((outcome) => outcome.scores.citationPrecision)),
    citationsResolve: mean(outcomes.map((outcome) => outcome.scores.citationsResolve)),
    answerContains: mean(outcomes.map((outcome) => outcome.scores.answerContains)),
    falseAnswerRate: rates.falseAnswerRate,
    overAbstentionRate: rates.overAbstentionRate,
    meanLatencyMs: mean(outcomes.map((outcome) => outcome.latencyMs)),
    meanIterations: mean(outcomes.map((outcome) => outcome.trace?.iterations ?? 0)),
  };

  // A partial run keeps its metrics but stays open, so resuming appends rather
  // than starting a second run over the same dataset.
  await db
    .update(evalRuns)
    .set({ metrics, ...(partial ? {} : { finishedAt: new Date() }) })
    .where(eq(evalRuns.id, runId));

  return { runId, mode, outcomes, metrics, partial, remaining };
}
