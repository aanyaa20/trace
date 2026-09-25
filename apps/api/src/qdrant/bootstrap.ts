import type { Logger } from 'pino';
import {
  CLIP_DIM,
  CLIP_VECTOR,
  COLLECTION,
  DENSE_DIM,
  DENSE_VECTOR,
  SPARSE_VECTOR,
  qdrant,
} from './client.js';
import { toError } from '../errors.js';

const PAYLOAD_INDEXES = [
  { field: 'kb_id', schema: 'keyword' },
  { field: 'document_id', schema: 'keyword' },
  { field: 'modality', schema: 'keyword' },
] as const;

/**
 * Creates the collection and payload indexes when absent. Safe on every boot
 * and from concurrent replicas: Qdrant reports an existing index as a 4xx,
 * which is the expected steady state rather than a failure.
 */
export async function ensureCollection(logger: Logger): Promise<void> {
  const { collections } = await qdrant.getCollections();

  if (!collections.some((collection) => collection.name === COLLECTION)) {
    await qdrant.createCollection(COLLECTION, {
      vectors: {
        [DENSE_VECTOR]: { size: DENSE_DIM, distance: 'Cosine' },
        [CLIP_VECTOR]: { size: CLIP_DIM, distance: 'Cosine' },
      },
      // fastembed's Qdrant/bm25 emits raw term frequencies; the idf modifier
      // tells Qdrant to apply inverse document frequency at query time.
      sparse_vectors: { [SPARSE_VECTOR]: { modifier: 'idf' } },
      optimizers_config: { default_segment_number: 2 },
    });
    logger.info({ collection: COLLECTION }, 'qdrant collection created');
  }

  for (const { field, schema } of PAYLOAD_INDEXES) {
    try {
      await qdrant.createPayloadIndex(COLLECTION, {
        field_name: field,
        field_schema: schema,
        wait: true,
      });
    } catch (cause) {
      logger.debug(
        { collection: COLLECTION, field, reason: toError(cause).message },
        'payload index already present',
      );
    }
  }
}
