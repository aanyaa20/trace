import { z } from 'zod';
import { blockSourceSchema, modalitySchema, retrievalModeSchema } from './common.js';
import { citationSchema } from './citations.js';

export const agentStageSchema = z.enum([
  /** Answered as conversation, without retrieval. A greeting makes no claim
   *  about the corpus, so there is nothing to retrieve and nothing to cite. */
  'converse',
  'analyse',
  'retrieve',
  'grade',
  'sufficiency',
  'web_search',
  'synthesise',
  'citations',
]);
export type AgentStage = z.infer<typeof agentStageSchema>;

export const agentStatusSchema = z.enum(['started', 'completed', 'failed']);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const queryAnalysisSchema = z.object({
  intent: z.string(),
  modalityHints: z.array(modalitySchema),
  rewrites: z.array(z.string()).min(1).max(3),
  reasoning: z.string(),
  /**
   * The question with references to earlier turns resolved into words a
   * retriever can match ("what about the second one?" becomes the thing it
   * refers to). Absent on the first turn of a conversation, and absent in
   * naive mode, which has no analysis stage at all.
   */
  standaloneQuery: z.string().optional(),
});
export type QueryAnalysis = z.infer<typeof queryAnalysisSchema>;

/** A chunk travelling through the loop. Score semantics differ per stage:
 *  RRF rank score after retrieve, grader confidence after grade. */
export const retrievedChunkSchema = z.object({
  chunkId: z.string().uuid(),
  documentId: z.string().uuid(),
  filename: z.string(),
  modality: modalitySchema,
  source: blockSourceSchema,
  text: z.string(),
  score: z.number(),
  page: z.number().int().positive().nullable(),
  charStart: z.number().int().nonnegative().nullable(),
  charEnd: z.number().int().nonnegative().nullable(),
  tsStart: z.number().nonnegative().nullable(),
  tsEnd: z.number().nonnegative().nullable(),
  imagePath: z.string().nullable(),
  external: z.boolean().default(false),
  externalUrl: z.string().url().nullable().default(null),
});
export type RetrievedChunk = z.infer<typeof retrievedChunkSchema>;

export const chunkGradeSchema = z.object({
  chunkId: z.string().uuid(),
  relevant: z.boolean(),
  score: z.number().min(0).max(1),
  /** One honest sentence about this chunk, rendered verbatim in the UI. */
  reason: z.string(),
});
export type ChunkGrade = z.infer<typeof chunkGradeSchema>;

export const sufficiencyDecisionSchema = z.enum(['answer', 'retry', 'web_fallback', 'abstain']);
export type SufficiencyDecision = z.infer<typeof sufficiencyDecisionSchema>;

export const agentEventPayloadSchema = z.discriminatedUnion('stage', [
  z.object({ stage: z.literal('converse'), kind: z.string() }),
  z.object({ stage: z.literal('analyse'), analysis: queryAnalysisSchema.nullable() }),
  z.object({
    stage: z.literal('retrieve'),
    queries: z.array(z.string()),
    chunks: z.array(retrievedChunkSchema),
    candidateCount: z.number().int().nonnegative(),
  }),
  z.object({
    stage: z.literal('grade'),
    grades: z.array(chunkGradeSchema),
    keptCount: z.number().int().nonnegative(),
  }),
  z.object({
    stage: z.literal('sufficiency'),
    decision: sufficiencyDecisionSchema,
    rationale: z.string(),
    relevantCount: z.number().int().nonnegative(),
    /** Echoed so a trace read months later explains its own decision. */
    thresholds: z.object({ minRelevantChunks: z.number(), minScore: z.number() }),
  }),
  z.object({
    stage: z.literal('web_search'),
    query: z.string(),
    results: z.array(retrievedChunkSchema),
  }),
  z.object({
    stage: z.literal('synthesise'),
    abstained: z.boolean(),
    characters: z.number().int().nonnegative(),
  }),
  z.object({
    stage: z.literal('citations'),
    citations: z.array(citationSchema),
    /** Markers the model emitted that failed span verification and were cut. */
    rejectedMarkers: z.array(z.number().int().positive()),
  }),
]);

export const agentEventSchema = z.object({
  stage: agentStageSchema,
  status: agentStatusSchema,
  /** 1-based retrieval cycle this event belongs to. */
  iteration: z.number().int().positive(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  payload: agentEventPayloadSchema.nullable(),
  error: z.string().nullable(),
});
export type AgentEvent = z.infer<typeof agentEventSchema>;

export const agentTraceSchema = z.object({
  mode: retrievalModeSchema,
  iterations: z.number().int().nonnegative(),
  events: z.array(agentEventSchema),
  totalMs: z.number().int().nonnegative(),
});
export type AgentTrace = z.infer<typeof agentTraceSchema>;
