import { z } from 'zod';
import { blockSourceSchema, modalitySchema } from './common.js';

/**
 * A citation resolves to an exact location. Which locator fields are populated
 * depends on modality: page plus character span for pdf and text, a timestamp
 * span for audio and video, imagePath for image.
 */
export const citationSchema = z.object({
  /** The n in the [^n] marker emitted by synthesis. 1-based. */
  marker: z.number().int().positive(),
  chunkId: z.string().uuid(),
  documentId: z.string().uuid(),
  filename: z.string(),
  modality: modalitySchema,
  source: blockSourceSchema,
  page: z.number().int().positive().nullable(),
  charStart: z.number().int().nonnegative().nullable(),
  charEnd: z.number().int().nonnegative().nullable(),
  tsStart: z.number().nonnegative().nullable(),
  tsEnd: z.number().nonnegative().nullable(),
  imagePath: z.string().nullable(),
  snippet: z.string(),
  /** True for web-search fallback results, which are not part of the corpus. */
  external: z.boolean().default(false),
  externalUrl: z.string().url().nullable().default(null),
});
export type Citation = z.infer<typeof citationSchema>;

export const resolvedCitationSchema = citationSchema.extend({
  /** The full chunk plus its neighbours, for the sources panel. */
  context: z.string(),
  previewUrl: z.string().nullable(),
});
export type ResolvedCitation = z.infer<typeof resolvedCitationSchema>;
