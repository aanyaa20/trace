import { z } from 'zod';
import { modalitySchema } from './common.js';

/**
 * One projected chunk vector. Unlike the reference implementation, which
 * projects a mean vector per source, every chunk is its own point so the
 * visualiser shows intra-document spread.
 */
export const embeddingPointSchema = z.object({
  chunkId: z.string().uuid(),
  documentId: z.string().uuid(),
  filename: z.string(),
  modality: modalitySchema,
  x: z.number(),
  y: z.number(),
  z: z.number(),
  preview: z.string(),
});
export type EmbeddingPoint = z.infer<typeof embeddingPointSchema>;

export const embeddingMapQuerySchema = z.object({
  /** Optional query projected into the same basis as the corpus points. */
  query: z.string().max(4000).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(2000),
});
export type EmbeddingMapQuery = z.infer<typeof embeddingMapQuerySchema>;

export const embeddingMapSchema = z.object({
  points: z.array(embeddingPointSchema),
  /** Present only when the request carried a query. */
  queryPoint: z.object({ x: z.number(), y: z.number(), z: z.number() }).nullable(),
  method: z.literal('pca3'),
  /** Fraction of variance captured by the three retained components. */
  explainedVariance: z.array(z.number()).length(3),
  totalChunks: z.number().int().nonnegative(),
});
export type EmbeddingMap = z.infer<typeof embeddingMapSchema>;
