import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from '../env.js';

export const DENSE_VECTOR = 'dense' as const;
export const CLIP_VECTOR = 'clip' as const;
export const SPARSE_VECTOR = 'bm25' as const;

export const DENSE_DIM = 384;
export const CLIP_DIM = 512;

export const COLLECTION = env.QDRANT_COLLECTION;

export const qdrant = new QdrantClient({
  url: env.QDRANT_URL,
  ...(env.QDRANT_API_KEY ? { apiKey: env.QDRANT_API_KEY } : {}),
  // Qdrant Cloud serves on 6333 behind HTTPS on 443; without this the client
  // appends :6333 to an https URL that does not listen there.
  ...(env.QDRANT_URL.startsWith('https://') ? { port: Number(new URL(env.QDRANT_URL).port || 443) } : {}),
  checkCompatibility: false,
});

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
  section: string | null;
  /** chart, table, photo… for a region of an image or scanned page. */
  region_type?: string | null;
  text_preview: string;
  [key: string]: unknown;
}
