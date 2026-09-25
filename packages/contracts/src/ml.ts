import { z } from 'zod';
import { blockSourceSchema, modalitySchema } from './common.js';

export const sparseVectorSchema = z.object({
  indices: z.array(z.number().int().nonnegative()),
  values: z.array(z.number()),
});
export type SparseVector = z.infer<typeof sparseVectorSchema>;

/**
 * The unit services/ml returns. A block is pre-chunk: one PDF page, one
 * whisper segment, one keyframe, one image. Node does all chunking, so
 * character offsets are computed in exactly one place.
 */
export const extractBlockSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  kind: z.enum(['text', 'image']),
  source: blockSourceSchema,
  text: z.string(),
  page: z.number().int().positive().nullable(),
  tsStart: z.number().nonnegative().nullable(),
  tsEnd: z.number().nonnegative().nullable(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  /** Path on the shared uploads volume, for image blocks and rendered pages. */
  imagePath: z.string().nullable(),
});
export type ExtractBlock = z.infer<typeof extractBlockSchema>;

export const extractRequestSchema = z.object({
  path: z.string().min(1),
  mime: z.string().min(1),
  documentId: z.string().uuid(),
});
export type ExtractRequest = z.infer<typeof extractRequestSchema>;

export const extractResponseSchema = z.object({
  modality: modalitySchema,
  pageCount: z.number().int().nonnegative().nullable(),
  durationSec: z.number().nonnegative().nullable(),
  blocks: z.array(extractBlockSchema),
  /** Non-fatal degradations: OCR fallbacks, skipped pages, file-api use. */
  warnings: z.array(z.string()),
});
export type ExtractResponse = z.infer<typeof extractResponseSchema>;

export const embedTextRequestSchema = z.object({
  texts: z.array(z.string()).min(1).max(256),
});
export type EmbedTextRequest = z.infer<typeof embedTextRequestSchema>;

export const embedTextResponseSchema = z.object({
  dense: z.array(z.array(z.number())),
  sparse: z.array(sparseVectorSchema),
});
export type EmbedTextResponse = z.infer<typeof embedTextResponseSchema>;

export const embedImageRequestSchema = z.object({
  paths: z.array(z.string()).min(1).max(32),
  caption: z.boolean().default(true),
});
export type EmbedImageRequest = z.infer<typeof embedImageRequestSchema>;

export const embedImageResponseSchema = z.object({
  clip: z.array(z.array(z.number())),
  /** Null when captioning is disabled or no Gemini key is configured. */
  captions: z.array(z.string().nullable()),
});
export type EmbedImageResponse = z.infer<typeof embedImageResponseSchema>;

export const embedQueryRequestSchema = z.object({
  query: z.string().min(1).max(4000),
  /** Also return a CLIP text vector, for reaching image-only chunks. */
  includeClip: z.boolean().default(false),
});
export type EmbedQueryRequest = z.infer<typeof embedQueryRequestSchema>;

export const embedQueryResponseSchema = z.object({
  dense: z.array(z.number()),
  sparse: sparseVectorSchema,
  clip: z.array(z.number()).nullable(),
});
export type EmbedQueryResponse = z.infer<typeof embedQueryResponseSchema>;

export const modelStateSchema = z.enum(['cold', 'loading', 'loaded', 'error']);
export type ModelState = z.infer<typeof modelStateSchema>;

export const mlHealthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeSec: z.number().nonnegative(),
  models: z.record(z.string(), modelStateSchema),
  errors: z.record(z.string(), z.string()),
});
export type MlHealth = z.infer<typeof mlHealthSchema>;
