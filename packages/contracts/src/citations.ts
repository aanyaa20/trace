import { z } from 'zod';
import { bboxSchema, blockSourceSchema, modalitySchema, regionTypeSchema } from './common.js';

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
  /** Heading or slide title the passage sits under, when known. */
  section: z.string().nullable().default(null),
  /** True for web-search fallback results, which are not part of the corpus. */
  external: z.boolean().default(false),
  externalUrl: z.string().url().nullable().default(null),
  /**
   * The region of an image or scanned page the claim came from: what kind of
   * thing it is, its printed title, and where it sits, so the reader is told
   * "the Market Size chart" rather than shown a paragraph that is not there,
   * and the viewer can outline it.
   */
  region: z
    .object({
      id: z.string(),
      type: regionTypeSchema,
      title: z.string().nullable(),
      bbox: bboxSchema.nullable(),
    })
    .nullable()
    .default(null),
});
export type Citation = z.infer<typeof citationSchema>;

export const resolvedCitationSchema = citationSchema.extend({
  /** The full chunk plus its neighbours, for the sources panel. */
  context: z.string(),
  previewUrl: z.string().nullable(),
});
export type ResolvedCitation = z.infer<typeof resolvedCitationSchema>;
