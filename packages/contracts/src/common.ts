import { z } from 'zod';

export const modalitySchema = z.enum(['text', 'pdf', 'image', 'audio', 'video']);
export type Modality = z.infer<typeof modalitySchema>;

export const documentStatusSchema = z.enum(['queued', 'processing', 'indexed', 'failed']);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

export const retrievalModeSchema = z.enum(['agentic', 'naive']);
export type RetrievalMode = z.infer<typeof retrievalModeSchema>;

/** Where a block's text came from. Shown in the UI so a reader can tell an
 *  OCR guess from embedded text, and a caption from a transcript. */
export const blockSourceSchema = z.enum(['text', 'ocr', 'asr', 'caption', 'vision']);
export type BlockSource = z.infer<typeof blockSourceSchema>;

export const regionTypeSchema = z.enum([
  'text',
  'chart',
  'table',
  'diagram',
  'photo',
  'form',
  'handwriting',
  'screenshot',
]);
export type RegionType = z.infer<typeof regionTypeSchema>;

/** Normalised to the image or page, 0-1: x0, y0, x1, y1. */
export const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type BBox = z.infer<typeof bboxSchema>;

/**
 * One region of an image or scanned page: a paragraph, a chart, a table, a
 * photo. Charts and tables keep their label-value pairs as records, so "2024"
 * and "28.9" travel together as one fact rather than as two OCR tokens a
 * dozen lines apart. Mirrors VisualRegion in services/ml/app/schemas.py.
 */
export const visualRegionSchema = z.object({
  id: z.string(),
  type: regionTypeSchema,
  title: z.string().nullable().default(null),
  unit: z.string().nullable().default(null),
  /** What a photo, diagram or chart shows, in words; from a vision model. */
  description: z.string().nullable().default(null),
  text: z.string().nullable().default(null),
  /** Column order for `data`. For a chart: the x-axis label, then each series. */
  columns: z.array(z.string()).default([]),
  data: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).default([]),
  bbox: bboxSchema.nullable().default(null),
  /** "layout" is geometry on the OCR boxes; "vision" is a vision model's read. */
  origin: z.enum(['layout', 'vision']),
  /** Values read off an axis because the chart prints none. */
  estimated: z.boolean().default(false),
  /** Share of the region's numbers OCR independently read. Null: no numbers. */
  ocrAgreement: z.number().min(0).max(1).nullable().default(null),
});
export type VisualRegion = z.infer<typeof visualRegionSchema>;

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
