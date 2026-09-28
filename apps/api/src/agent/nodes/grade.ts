import { z } from 'zod';
import type { ChunkGrade, RetrievedChunk } from '@trace/contracts';
import { env } from '../../env.js';
import { toError } from '../../errors.js';
import { logger } from '../../logger.js';
import type { AgentContext, AgentState } from '../state.js';
import { keywordQuery, searchQuery } from './analyse.js';

// Several chunks per call rather than one each: the free tier is rate limited
// per request, not per token, and the quota is five requests per minute for
// this model. At four chunks per call a single grading pass consumed most of
// a minute's budget; twelve fits a full candidate set into one or two calls.
const BATCH_SIZE = 12;
// The reranker has already put the most relevant passages first; the grader
// needs enough of each to judge it, not all of it. Fewer tokens per pass is
// what fits a free tier's tokens-per-minute budget. Which 800 is chosen by
// focusWindow, not taken from the start.
const MAX_CHARS_PER_CHUNK = 800;

/** Lowercase content terms of a question, numbers included. */
function termsOf(query: string): Set<string> {
  return new Set(
    keywordQuery(query)
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 1),
  );
}

/**
 * The part of a long passage the grader is shown: the window of at most
 * `max` characters, starting on a line or sentence boundary, that contains
 * the most of the question's terms.
 *
 * Always taking the first 800 characters is how a correct answer was once
 * refused. An uploaded infographic was one 2,197-character chunk; the market
 * figures the question asked about sat after character 800, the grader was
 * told the passage "does not mention 2024", and Folio abstained with the
 * number in its own index. A passage is judged on the part that could answer.
 */
export function focusWindow(text: string, query: string, max = MAX_CHARS_PER_CHUNK): string {
  if (text.length <= max) return text;
  const terms = termsOf(query);
  const starts = [0];
  for (const match of text.matchAll(/(?:\n|[.!?]\s)/g)) {
    const at = (match.index ?? 0) + match[0].length;
    if (at < text.length) starts.push(at);
  }

  let best = { start: 0, score: -1 };
  for (const start of starts) {
    const window = text.slice(start, start + max).toLowerCase();
    let score = 0;
    for (const term of terms) if (window.includes(term)) score += 1;
    if (score > best.score) best = { start, score };
  }
  const window = text.slice(best.start, best.start + max);
  return `${best.start > 0 ? '… ' : ''}${window}${best.start + max < text.length ? ' …' : ''}`;
}

/**
 * Grading has a local fallback (the reranker), so it does not wait out a long
 * rate-limit pause: one quick retry, then the fallback. Waiting four times
 * sixty seconds only to fall back anyway made a single question take minutes.
 */
const FAIL_FAST = { maxRetries: 1, maxRetryDelayMs: 20_000 } as const;

const batchGradeSchema = z.object({
  grades: z.array(
    z.object({
      id: z.number().int().nonnegative(),
      relevant: z.boolean(),
      score: z.number().min(0).max(1),
      reason: z.string().min(1).max(300),
    }),
  ),
});

const SYSTEM = `You judge whether a retrieved passage helps answer a question.
You are strict: a passage that merely shares vocabulary with the question is
not relevant. You never answer the question yourself.`;

const SHAPE = `{"grades":[{"id":0,"relevant":true,"score":0.0,"reason":"one sentence"}]}`;

function prompt(query: string, batch: RetrievedChunk[]): string {
  const passages = batch
    .map((chunk, index) => `[${index}] ${focusWindow(chunk.text, query)}`)
    .join('\n\n');

  return `Question: ${query}

Passages:
${passages}

For each passage return:
- relevant: true only if it contains information that would appear in a correct
  answer to the question, or directly supports such information. A
  description of a picture is relevant to a question about what that picture
  shows, depicts or represents: what is visibly in it is the evidence an
  answer can give, even when the passage does not interpret it. When the
  question compares two things — a chart with the text, one section with
  another — a passage covering either side is relevant: the comparison is
  built from both.
- score: your confidence between 0 and 1.
- reason: one short sentence explaining the verdict. Say what the passage does
  or does not contain, in your own words. Do not quote or summarise the passage
  back, and do not restate the question. This sentence is shown to the user.

Return a grade for every passage, with the id matching its bracketed number.`;
}

async function gradeBatch(
  query: string,
  batch: RetrievedChunk[],
  ctx: AgentContext,
): Promise<ChunkGrade[]> {
  const ask = (model: AgentContext['llm']) =>
    model.generateStructured(prompt(query, batch), batchGradeSchema, SHAPE, {
      system: SYSTEM,
      temperature: 0,
      signal: ctx.signal,
      ...FAIL_FAST,
    });
  let result: z.infer<typeof batchGradeSchema>;
  try {
    result = await ask(ctx.fastLlm);
  } catch (cause) {
    // The grading model is separate so it does not spend the answer model's
    // quota, but on a free tier its own daily token cap runs out first. When
    // it does, the answer model grades instead: its quota is separate, and
    // the alternative is the reranker alone, which cannot read a table or a
    // diagram description and refused answers the corpus plainly held.
    if (ctx.llm === ctx.fastLlm || !/\b429\b|rate limit/i.test(toError(cause).message)) throw cause;
    logger.warn('grading model rate-limited; grading this batch with the answer model');
    result = await ask(ctx.llm);
  }

  const grades: ChunkGrade[] = [];
  for (const grade of result.grades) {
    const chunk = batch[grade.id];
    // A model that invents an index is not describing any passage we sent.
    if (!chunk) continue;
    grades.push({
      chunkId: chunk.chunkId,
      relevant: grade.relevant,
      score: grade.score,
      reason: grade.reason.trim(),
    });
  }
  return grades;
}

/**
 * The reranker standing in for the grader: a candidate is evidence when its
 * cross-encoder score clears RERANK_FALLBACK_MIN_SCORE. Only ever applied to
 * chunks the LLM did not grade — a verdict from the grader is never overruled.
 */
export function rerankVerdicts(
  chunks: RetrievedChunk[],
  minScore: number,
): { kept: RetrievedChunk[]; grades: ChunkGrade[] } {
  const kept: RetrievedChunk[] = [];
  const grades: ChunkGrade[] = [];
  for (const chunk of chunks) {
    if (chunk.rerankScore === null) continue;
    const relevant = chunk.rerankScore >= minScore;
    grades.push({
      chunkId: chunk.chunkId,
      relevant,
      score: chunk.rerankScore,
      reason: relevant
        ? 'Judged relevant by the local reranker (the LLM grader was unavailable).'
        : 'Scored too low by the local reranker (the LLM grader was unavailable).',
    });
    if (relevant) kept.push({ ...chunk, score: chunk.rerankScore, gradedBy: 'rerank' });
  }
  return { kept, grades };
}

/**
 * Grades the reranked candidates against the resolved question.
 *
 * A batch the LLM fails to grade is not simply dropped any more. Dropping it
 * made a per-minute rate limit indistinguishable from "the corpus has no
 * answer", and the loop refused questions its own retrieval had answered.
 * Instead the cross-encoder's score — a genuine relevance judgement, made
 * locally — decides for those chunks, under its own, separately calibrated
 * threshold. Only when neither judge is available is nothing kept, and then
 * the reply says the service failed, not the documents.
 *
 * GRADE_WITH_LLM=false skips the LLM entirely and lets the reranker decide.
 */
export async function grade(state: AgentState, ctx: AgentContext): Promise<AgentState> {
  const stage = ctx.bus.begin('grade', state.iteration);

  if (state.candidates.length === 0) {
    stage.complete({ stage: 'grade', grades: [], keptCount: state.relevant.length });
    return state;
  }

  const query = searchQuery(state);
  const batches: RetrievedChunk[][] = [];
  if (env.GRADE_WITH_LLM) {
    for (let i = 0; i < state.candidates.length; i += BATCH_SIZE) {
      batches.push(state.candidates.slice(i, i + BATCH_SIZE));
    }
  }

  const settled = await Promise.allSettled(batches.map((batch) => gradeBatch(query, batch, ctx)));

  const grades: ChunkGrade[] = [];
  const failures: string[] = [];
  const ungraded: RetrievedChunk[] = env.GRADE_WITH_LLM ? [] : [...state.candidates];
  settled.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') grades.push(...outcome.value);
    else {
      failures.push(toError(outcome.reason).message);
      // Logged, because a grader that silently fails hands every verdict to
      // the reranker, and that changes answers without saying why.
      logger.warn({ err: toError(outcome.reason).message.slice(0, 500) }, 'grading batch failed');
      ungraded.push(...(batches[index] ?? []));
    }
  });

  const byId = new Map(grades.map((entry) => [entry.chunkId, entry]));
  const keptByLlm = state.candidates
    .filter((chunk) => byId.get(chunk.chunkId)?.relevant === true)
    .map((chunk) => ({
      ...chunk,
      score: byId.get(chunk.chunkId)?.score ?? chunk.score,
      gradedBy: 'llm' as const,
    }));

  const fallback = rerankVerdicts(ungraded, env.RERANK_FALLBACK_MIN_SCORE);

  const relevant = [...state.relevant, ...keptByLlm, ...fallback.kept].sort(
    (a, b) => b.score - a.score,
  );
  const allGrades = [...state.grades, ...grades, ...fallback.grades];

  const llmAllFailed = batches.length > 0 && failures.length === batches.length;
  if (llmAllFailed && fallback.grades.length === 0) {
    stage.fail(`every grading batch failed and no reranker scores to fall back on: ${failures[0] ?? 'unknown error'}`);
  } else {
    stage.complete({ stage: 'grade', grades: [...grades, ...fallback.grades], keptCount: relevant.length });
  }

  // "Graded" now means either judge produced a verdict. The service-failure
  // reply is reserved for runs where neither could.
  const judged = grades.length > 0 || fallback.grades.length > 0;
  return {
    ...state,
    grades: allGrades,
    relevant,
    gradedOk: state.gradedOk || judged,
    llmGraded: state.llmGraded || grades.length > 0,
    llmGradeFailed: state.llmGradeFailed || failures.length > 0,
    gradeFailed: state.gradeFailed || (batches.length > 0 && failures.length > 0 && !judged),
  };
}
