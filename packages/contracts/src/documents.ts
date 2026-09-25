import { z } from 'zod';
import { documentStatusSchema, modalitySchema } from './common.js';

export const documentSchema = z.object({
  id: z.string().uuid(),
  kbId: z.string().uuid(),
  filename: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  modality: modalitySchema,
  status: documentStatusSchema,
  error: z.string().nullable(),
  pageCount: z.number().int().nonnegative().nullable(),
  durationSec: z.number().nonnegative().nullable(),
  chunkCount: z.number().int().nonnegative(),
  /**
   * How many pages were rendered to an image during extraction. Only scanned
   * pages are rendered — a text-layer PDF yields none — and the reader has to
   * know, because putting a PDF behind an <img> produces a broken image icon
   * rather than a page.
   */
  renderedPages: z.number().int().nonnegative(),
  sourceUrl: z.string().url().nullable(),
  /** Set when the document was pulled from a connected mailbox. The interface
   *  groups the corpus by where each document came from, and "who put this
   *  here" is a different question from "what is it". */
  connectorId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Document = z.infer<typeof documentSchema>;

export const documentListSchema = z.object({ documents: z.array(documentSchema) });
export type DocumentList = z.infer<typeof documentListSchema>;

export const ingestUrlRequestSchema = z.object({
  url: z.string().url(),
  title: z.string().max(200).optional(),
});
export type IngestUrlRequest = z.infer<typeof ingestUrlRequestSchema>;

export const uploadAcceptedSchema = z.object({
  documents: z.array(
    z.object({
      id: z.string().uuid(),
      filename: z.string(),
      status: documentStatusSchema,
    }),
  ),
});
export type UploadAccepted = z.infer<typeof uploadAcceptedSchema>;

export const ingestionStageSchema = z.enum([
  'queued',
  'extracting',
  'chunking',
  'embedding',
  'indexing',
  'completed',
  'failed',
]);
export type IngestionStage = z.infer<typeof ingestionStageSchema>;

/** Payload of every frame on GET /events/ingestion/:kbId. */
export const ingestionEventSchema = z.object({
  documentId: z.string().uuid(),
  kbId: z.string().uuid(),
  filename: z.string(),
  stage: ingestionStageSchema,
  /** 0-1, monotonic within a document; resets only on retry. */
  progress: z.number().min(0).max(1),
  detail: z.string().optional(),
  error: z.string().optional(),
  at: z.string().datetime(),
});
export type IngestionEvent = z.infer<typeof ingestionEventSchema>;
