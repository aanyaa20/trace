import { z } from 'zod';
import type { ChunkGrade, RetrievedChunk } from '@trace/contracts';
import { toError } from '../../errors.js';
import type { AgentContext, AgentState } from '../state.js';

// Several chunks per call rather than one each: the free tier is rate limited
// per request, not per token, and the quota is five requests per minute for
// this model. At four chunks per call a single grading pass consumed most of
// a minute's budget; twelve fits a full candidate set into one or two calls.
const BATCH_SIZE = 12;
const MAX_CHARS_PER_CHUNK = 1200;

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
    .map((chunk, index) => `[${index}] ${chunk.text.slice(0, MAX_CHARS_PER_CHUNK)}`)
    .join('\n\n');

  return `Question: ${query}

Passages:
${passages}

For each passage return:
- relevant: true only if it contains information that would appear in a correct
  answer to the question, or directly supports such information.
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
  const result = await ctx.fastLlm.generateStructured(prompt(query, batch), batchGradeSchema, SHAPE, {
    system: SYSTEM,
    temperature: 0,
    signal: ctx.signal,
  });

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
 * Grades every candidate. A batch that fails is dropped rather than kept:
 * the reference implementation keeps ungraded chunks "to be safe", which
 * biases the system toward answering exactly when its judgement is least
 * reliable. Dropping biases toward abstention instead, and the failure is
 * visible in the trace either way.
 */
export async function grade(state: AgentState, ctx: AgentContext): Promise<AgentState> {
  const stage = ctx.bus.begin('grade', state.iteration);

  if (state.candidates.length === 0) {
    stage.complete({ stage: 'grade', grades: [], keptCount: state.relevant.length });
    return state;
  }

  const batches: RetrievedChunk[][] = [];
  for (let i = 0; i < state.candidates.length; i += BATCH_SIZE) {
    batches.push(state.candidates.slice(i, i + BATCH_SIZE));
  }

  const settled = await Promise.allSettled(
    batches.map((batch) => gradeBatch(state.userQuery, batch, ctx)),
  );

  const grades: ChunkGrade[] = [];
  const failures: string[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') grades.push(...outcome.value);
    else failures.push(toError(outcome.reason).message);
  }

  const byId = new Map(grades.map((entry) => [entry.chunkId, entry]));
  const keptNow = state.candidates
    .filter((chunk) => byId.get(chunk.chunkId)?.relevant === true)
    .map((chunk) => ({ ...chunk, score: byId.get(chunk.chunkId)?.score ?? chunk.score }));

  const relevant = [...state.relevant, ...keptNow].sort((a, b) => b.score - a.score);
  const allGrades = [...state.grades, ...grades];

  if (failures.length === batches.length) {
    stage.fail(`every grading batch failed: ${failures[0] ?? 'unknown error'}`);
  } else {
    stage.complete({ stage: 'grade', grades, keptCount: relevant.length });
  }

  return { ...state, grades: allGrades, relevant };
}
