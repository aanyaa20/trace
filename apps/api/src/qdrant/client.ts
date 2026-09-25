import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from '../env.js';

export const DENSE_VECTOR = 'dense' as const;
export const CLIP_VECTOR = 'clip' as const;
export const SPARSE_VECTOR = 'bm25' as const;

export const DENSE_DIM = 384;
export const CLIP_DIM = 512;

export const COLLECTION = env.QDRANT_COLLECTION;

export const qdrant = new QdrantClient({ url: env.QDRANT_URL, checkCompatibility: false });

/** Payload stored with every point. Flat, so Qdrant can index and filter it. */
export interface ChunkPayload {
  chunk_id: string;
  document_id: string;
  kb_id: string;
  modality: string;
  source: string;
  page: number | null;
  ts_start: number | null;
  ts_end: number | null;
  filename: string;
  image_path: string | null;
  text_preview: string;
  [key: string]: unknown;
}
