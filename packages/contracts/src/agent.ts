import { z } from 'zod';
import {
  blockSourceSchema,
  modalitySchema,
  regionTypeSchema,
  retrievalModeSchema,
  visualRegionSchema,
} from './common.js';
import { citationSchema } from './citations.js';

export const agentStageSchema = z.enum([
  /** Answered as conversation, without retrieval. A greeting makes no claim
   *  about the corpus, so there is nothing to retrieve and nothing to cite. */
  'converse',
  'analyse',
  'retrieve',
  /** Cross-encoder reordering of the fused candidates, before grading. */
  'rerank',
  'grade',
  'sufficiency',
  'web_search',
  /** Before abstaining: the images retrieval found, looked at directly. */
  'visual_check',
  'synthesise',
  'citations',
]);
export type AgentStage = z.infer<typeof agentStageSchema>;

export const agentStatusSchema = z.enum(['started', 'completed', 'failed']);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/**
 * What kind of evidence a question needs. A question about a value in a
 * given year is answered by a chart; "who scored highest" by a table; "what
 * does figure 2 show" by looking at the figure. Retrieval searches those
 * regions as well as the open index when the answer is likely to be in one.
 */
export const evidenceTypeSchema = z.enum(['text', 'table', 'chart', 'diagram', 'visual', 'mixed']);
export type EvidenceType = z.infer<typeof evidenceTypeSchema>;

export const queryAnalysisSchema = z.object({
  intent: z.string(),
  /**
   * One of evidenceTypeSchema's values. Kept a string here so a model that
   * answers "numeric" loses this one field rather than the whole plan; read
   * it through evidenceTypeOf. Absent from older traces.
   */
  evidenceType: z.string().optional(),
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

/** The analysis's evidence type, when it is one of the known values. */
export function evidenceTypeOf(analysis: QueryAnalysis | null | undefined): EvidenceType | null {
  const parsed = evidenceTypeSchema.safeParse(analysis?.evidenceType?.trim().toLowerCase());
  return parsed.success ? parsed.data : null;
}

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
  /** Heading or slide title the passage sits under, when known. */
  section: z.string().nullable().default(null),
  external: z.boolean().default(false),
  externalUrl: z.string().url().nullable().default(null),
  /** Cross-encoder relevance, 0-1, once the chunk has been reranked. */
  rerankScore: z.number().min(0).max(1).nullable().default(null),
  /** Who decided this chunk is evidence: the LLM grader, or the reranker
   *  standing in for it when the grader could not be reached. */
  gradedBy: z.enum(['llm', 'rerank']).nullable().default(null),
  /** The region of an image or scanned page this chunk is, when it is one. */
  visual: visualRegionSchema.nullable().default(null),
});
export type RetrievedChunk = z.infer<typeof retrievedChunkSchema>;

/** One image the visual check looked at, and what it saw. */
export const visualReadingSchema = z.object({
  chunkId: z.string().uuid(),
  filename: z.string(),
  regionType: regionTypeSchema.nullable(),
  regionTitle: z.string().nullable(),
  found: z.boolean(),
  answer: z.string().nullable(),
  model: z.string().nullable(),
});
export type VisualReading = z.infer<typeof visualReadingSchema>;

export const chunkGradeSchema = z.object({
  chunkId: z.string().uuid(),
  relevant: z.boolean(),
  score: z.number().min(0).max(1),
  /** One honest sentence about this chunk, rendered verbatim in the UI. */
  reason: z.string(),
});
export type ChunkGrade = z.infer<typeof chunkGradeSchema>;

/**
 * How sure retrieval is that it found the answer, computed from the scores the
 * pipeline actually produced — never estimated. `retrievalConfidence` is the
 * mean of the best three evidence scores (grader where it graded, reranker
 * where it stood in), so one lucky passage cannot carry it alone.
 */
export const retrievalConfidenceSchema = z.object({
  retrievalConfidence: z.number().min(0).max(1),
  topScore: z.number().min(0).max(1),
  /** Unique fused candidates retrieval returned this iteration. */
  candidateCount: z.number().int().nonnegative(),
  /** Candidates that survived reranking and went on to be graded. */
  rerankedCount: z.number().int().nonnegative(),
  /** Chunks accepted as evidence so far, across iterations. */
  evidenceCount: z.number().int().nonnegative(),
  basis: z.enum(['llm', 'rerank', 'mixed', 'none']),
});
export type RetrievalConfidence = z.infer<typeof retrievalConfidenceSchema>;

/** One reranked candidate, as the trace shows it: where it came from, how
 *  each stage scored it, and whether it went on to the grader. */
export const rerankedCandidateSchema = z.object({
  chunkId: z.string().uuid(),
  filename: z.string(),
  page: z.number().int().positive().nullable(),
  tsStart: z.number().nonnegative().nullable(),
  fusedScore: z.number(),
  rerankScore: z.number().min(0).max(1),
  kept: z.boolean(),
});

/** A source exactly as synthesis numbered it. Text only when AGENT_DEBUG. */
export const synthesisSourceSchema = z.object({
  n: z.number().int().positive(),
  chunkId: z.string(),
  filename: z.string(),
  page: z.number().int().positive().nullable(),
  tsStart: z.number().nonnegative().nullable(),
  tsEnd: z.number().nonnegative().nullable(),
  score: z.number(),
  external: z.boolean(),
  text: z.string().optional(),
});

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
    /** What kind of evidence the question was routed to. */
    evidenceType: evidenceTypeSchema.optional(),
  }),
  z.object({
    stage: z.literal('rerank'),
    query: z.string(),
    model: z.string(),
    candidates: z.array(rerankedCandidateSchema),
    keptCount: z.number().int().nonnegative(),
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
    confidence: retrievalConfidenceSchema.optional(),
  }),
  z.object({
    stage: z.literal('web_search'),
    query: z.string(),
    results: z.array(retrievedChunkSchema),
  }),
  z.object({
    stage: z.literal('visual_check'),
    /** Visual regions retrieved on their own, before any model looked. */
    regionCandidates: z.number().int().nonnegative(),
    readings: z.array(visualReadingSchema),
    /** False when no vision model could be reached. */
    visionAvailable: z.boolean(),
  }),
  z.object({
    stage: z.literal('synthesise'),
    abstained: z.boolean(),
    characters: z.number().int().nonnegative(),
    /** The question synthesis answered — the resolved follow-up if any. */
    question: z.string().optional(),
    sources: z.array(synthesisSourceSchema).optional(),
  }),
  z.object({
    stage: z.literal('citations'),
    citations: z.array(citationSchema),
    /** Markers the model emitted that failed span verification and were cut. */
    rejectedMarkers: z.array(z.number().int().positive()),
    /** Markers dropped because their sentence did not match the passage
     *  they pointed at (cross-encoder support check). */
    unsupportedMarkers: z.array(z.number().int().positive()).optional(),
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
