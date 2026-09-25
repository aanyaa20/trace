import { z } from 'zod';

export const modalitySchema = z.enum(['text', 'pdf', 'image', 'audio', 'video']);
export type Modality = z.infer<typeof modalitySchema>;

export const documentStatusSchema = z.enum(['queued', 'processing', 'indexed', 'failed']);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

export const retrievalModeSchema = z.enum(['agentic', 'naive']);
export type RetrievalMode = z.infer<typeof retrievalModeSchema>;

/** Where a block's text came from. Shown in the UI so a reader can tell an
 *  OCR guess from embedded text, and a caption from a transcript. */
export const blockSourceSchema = z.enum(['text', 'ocr', 'asr', 'caption']);
export type BlockSource = z.infer<typeof blockSourceSchema>;

/**
 * Every non-2xx response carries this shape. `code` is stable and safe to
 * branch on; `message` is for humans and may change between releases.
 */
export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
