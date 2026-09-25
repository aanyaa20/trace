import { and, asc, count, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EvalResult, EvalResultList, EvalRun, EvalRunList } from '@trace/contracts';
import { db } from '../db/client.js';
import { evalResults, evalRuns, knowledgeBases } from '../db/schema.js';
import { notFound } from '../errors.js';

const kbParams = z.object({ id: z.string().uuid() });
const runParams = z.object({ runId: z.string().uuid() });

type RunRow = typeof evalRuns.$inferSelect;

function toRun(row: RunRow, questionCount: number): EvalRun {
  return {
    id: row.id,
    kbId: row.kbId,
    dataset: row.dataset,
    mode: row.mode,
    notes: row.notes,
    config: row.config ?? null,
    metrics: row.metrics ?? null,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    questionCount,
  };
}

/**
 * Reads what the harness wrote. Runs are produced by the CLI against the real
 * retrieval layer and the real loop; this route only serves them, so a number
 * on screen is the same number the report was generated from rather than a
 * second measurement taken a different way.
 */
export default async function evaluationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.requireAuth);

  async function assertOwnedKb(kbId: string, userId: string): Promise<void> {
    const [owned] = await db
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.userId, userId)));
    if (!owned) throw notFound('knowledge base');
  }

  app.get('/kb/:id/eval/runs', async (request) => {
    const { id: kbId } = kbParams.parse(request.params);
    await assertOwnedKb(kbId, request.session.sub);

    const rows = await db
      .select({ run: evalRuns, questionCount: count(evalResults.id) })
      .from(evalRuns)
      .leftJoin(evalResults, eq(evalResults.runId, evalRuns.id))
      .where(eq(evalRuns.kbId, kbId))
      .groupBy(evalRuns.id)
      .orderBy(desc(evalRuns.startedAt));

    const body: EvalRunList = {
      runs: rows.map((row) => toRun(row.run, Number(row.questionCount))),
    };
    return body;
  });

  app.get('/eval/runs/:runId/results', async (request) => {
    const { runId } = runParams.parse(request.params);

    const [row] = await db
      .select({ run: evalRuns, ownerId: knowledgeBases.userId })
      .from(evalRuns)
      .innerJoin(knowledgeBases, eq(knowledgeBases.id, evalRuns.kbId))
      .where(eq(evalRuns.id, runId));

    if (!row || row.ownerId !== request.session.sub) throw notFound('evaluation run');

    const rows = await db
      .select()
      .from(evalResults)
      .where(eq(evalResults.runId, runId))
      .orderBy(asc(evalResults.id));

    const body: EvalResultList = {
      run: toRun(row.run, rows.length),
      results: rows.map(
        (result): EvalResult => ({
          id: result.id,
          runId: result.runId,
          question: result.question,
          expected: result.expected,
          answer: result.answer,
          abstained: result.abstained,
          citations: result.citations,
          scores: result.scores,
          latencyMs: result.latencyMs,
        }),
      ),
    };
    return body;
  });
}
