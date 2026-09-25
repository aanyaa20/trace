import { z } from 'zod';
import { retrievalModeSchema } from './common.js';
import { citationSchema } from './citations.js';

/**
 * Metrics are stored as a free map rather than a fixed shape. The harness adds
 * measures as the evaluation chapter needs them, and a schema that had to be
 * migrated for each one would make an added metric a deployment rather than a
 * line of code. The reader renders whatever keys a run recorded.
 */
export const evalRunSchema = z.object({
  id: z.string().uuid(),
  kbId: z.string().uuid(),
  dataset: z.string(),
  mode: retrievalModeSchema,
  notes: z.string().nullable(),
  config: z.record(z.union([z.number(), z.string()])).nullable(),
  metrics: z.record(z.number()).nullable(),
  startedAt: z.string().datetime(),
  /** Null while a run is still going, or after one stopped on an exhausted
   *  daily quota and is waiting to be resumed. */
  finishedAt: z.string().datetime().nullable(),
  questionCount: z.number().int().nonnegative(),
});
export type EvalRun = z.infer<typeof evalRunSchema>;

export const evalRunListSchema = z.object({ runs: z.array(evalRunSchema) });
export type EvalRunList = z.infer<typeof evalRunListSchema>;

export const evalResultSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  question: z.string(),
  expected: z.string().nullable(),
  answer: z.string(),
  abstained: z.boolean(),
  citations: z.array(citationSchema),
  scores: z.record(z.number()),
  latencyMs: z.number().int().nullable(),
});
export type EvalResult = z.infer<typeof evalResultSchema>;

export const evalResultListSchema = z.object({
  run: evalRunSchema,
  results: z.array(evalResultSchema),
});
export type EvalResultList = z.infer<typeof evalResultListSchema>;
