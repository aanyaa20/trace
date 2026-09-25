import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { IngestionStage, Modality } from '@trace/contracts';
import { db } from '../db/client.js';
import { chunks as chunksTable, documents } from '../db/schema.js';
import { env } from '../env.js';
import { internal, notFound, toError } from '../errors.js';
import { publishIngestionEvent } from '../events/ingestionBus.js';
import { COLLECTION, DENSE_VECTOR, SPARSE_VECTOR, qdrant, type ChunkPayload } from '../qdrant/client.js';
import { CLIP_VECTOR } from '../qdrant/client.js';
import { mlClient } from '../services/ml.js';
import { planChunks, type PlannedChunk } from './chunk.js';

const EMBED_BATCH = 64;
const IMAGE_BATCH = 8;

/** Progress is reported as a fraction so the UI needs no knowledge of stages. */
const STAGE_PROGRESS: Record<IngestionStage, number> = {
  queued: 0,
  extracting: 0.15,
  chunking: 0.35,
  embedding: 0.6,
  indexing: 0.85,
  completed: 1,
  failed: 1,
};

interface DocumentRow {
  id: string;
  kbId: string;
  filename: string;
  storagePath: string;
  mime: string;
  modality: Modality;
}

async function report(
  document: DocumentRow,
  stage: IngestionStage,
  detail?: string,
  error?: string,
): Promise<void> {
  await publishIngestionEvent({
    documentId: document.id,
    kbId: document.kbId,
    filename: document.filename,
    stage,
    progress: STAGE_PROGRESS[stage],
    at: new Date().toISOString(),
    ...(detail === undefined ? {} : { detail }),
    ...(error === undefined ? {} : { error }),
  });
}

function chunked<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/**
 * Image chunks carry no text of their own until they are captioned, so the
 * caption is fetched alongside the CLIP vector and becomes the text that the
 * dense and sparse encoders see. A frame nobody can describe is still indexed
 * by its vector.
 */
async function embedImages(
  planned: PlannedChunk[],
): Promise<Map<number, { clip: number[]; caption: string | null }>> {
  const imageChunks = planned.filter((chunk) => chunk.kind === 'image' && chunk.imagePath);
  const result = new Map<number, { clip: number[]; caption: string | null }>();

  for (const batch of chunked(imageChunks, IMAGE_BATCH)) {
    const response = await mlClient.embedImage({
      paths: batch.map((chunk) => chunk.imagePath!),
      caption: true,
    });
    batch.forEach((chunk, index) => {
      const clip = response.clip[index];
      if (clip) {
        result.set(chunk.ordinal, { clip, caption: response.captions[index] ?? null });
      }
    });
  }

  return result;
}


/** Why a file produced nothing to index, in terms of the file itself. */
function emptyReason(modality: string, filename: string): string {
  switch (modality) {
    case 'audio':
    case 'video':
      return `no speech was found in ${filename}. It was transcribed, but there were no words to index — music and ambient recordings have nothing citable in them.`;
    case 'image':
      return `no text was found in ${filename}. Images are indexed by the words in them, so a photograph with no writing has nothing to retrieve against.`;
    case 'pdf':
      return `no text could be read from ${filename}. If it is a scan, the pages were too poor for OCR to make out; if it is a slide deck of pictures, there may be no text to find.`;
    default:
      return `${filename} held no readable text, so there is nothing to index.`;
  }
}

export async function ingestDocument(documentId: string): Promise<void> {
  const [row] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!row) throw notFound(`document ${documentId}`);

  const document: DocumentRow = {
    id: row.id,
    kbId: row.kbId,
    filename: row.filename,
    storagePath: row.storagePath,
    mime: row.mime,
    modality: row.modality,
  };

  await db
    .update(documents)
    .set({ status: 'processing', error: null, updatedAt: new Date() })
    .where(eq(documents.id, documentId));

  try {
    await report(document, 'extracting');
    const extracted = await mlClient.extract({
      path: document.storagePath,
      mime: document.mime,
      documentId: document.id,
    });
    for (const warning of extracted.warnings) {
      await report(document, 'extracting', warning);
    }

    await report(document, 'chunking', `${extracted.blocks.length} blocks`);
    const planned = planChunks(extracted.blocks, {
      targetChars: env.CHUNK_SIZE_CHARS,
      overlapChars: env.CHUNK_OVERLAP_CHARS,
    });

    if (planned.length === 0) {
      // Nothing to index is usually not a broken file. A music track has no
      // speech, a photograph has no words in it, a scan can be too poor to
      // read. Saying "could not be read" for all of them sends someone
      // hunting for a fault in a file that is exactly what they think it is,
      // so the reason is named per modality.
      throw internal(emptyReason(document.modality, document.filename));
    }

    await report(document, 'embedding', `${planned.length} chunks`);
    const imageVectors = await embedImages(planned);

    // Captions arrive after chunk planning, so the text handed to the text
    // encoders is patched here rather than left empty.
    const texts = planned.map((chunk) => {
      const caption = imageVectors.get(chunk.ordinal)?.caption;
      const combined = [chunk.text, caption].filter((part) => part && part.trim()).join(' ');
      return combined.trim() || `${document.filename} image ${chunk.ordinal}`;
    });

    const dense: number[][] = [];
    const sparse: Array<{ indices: number[]; values: number[] }> = [];
    for (const batch of chunked(texts, EMBED_BATCH)) {
      const embedded = await mlClient.embedText({ texts: batch });
      dense.push(...embedded.dense);
      sparse.push(...embedded.sparse);
    }

    await report(document, 'indexing', `${planned.length} vectors`);

    const rows = planned.map((chunk, index) => ({
      id: randomUUID(),
      chunk,
      text: texts[index]!,
      dense: dense[index]!,
      sparse: sparse[index]!,
      clip: imageVectors.get(chunk.ordinal)?.clip,
    }));

    await qdrant.upsert(COLLECTION, {
      wait: true,
      points: rows.map((entry) => ({
        id: entry.id,
        vector: {
          [DENSE_VECTOR]: entry.dense,
          [SPARSE_VECTOR]: { indices: entry.sparse.indices, values: entry.sparse.values },
          ...(entry.clip ? { [CLIP_VECTOR]: entry.clip } : {}),
        },
        payload: {
          chunk_id: entry.id,
          document_id: document.id,
          kb_id: document.kbId,
          modality: document.modality,
          source: entry.chunk.source,
          page: entry.chunk.page,
          ts_start: entry.chunk.tsStart,
          ts_end: entry.chunk.tsEnd,
          filename: document.filename,
          image_path: entry.chunk.imagePath,
          text_preview: entry.text.slice(0, 240),
        } satisfies ChunkPayload,
      })),
    });

    // Postgres is written after Qdrant so a crash between the two leaves an
    // orphan vector, which retrieval filters out by chunk id, rather than a
    // chunk row pointing at a vector that does not exist.
    await db.transaction(async (tx) => {
      await tx.delete(chunksTable).where(eq(chunksTable.documentId, document.id));
      await tx.insert(chunksTable).values(
        rows.map((entry) => ({
          id: entry.id,
          documentId: document.id,
          kbId: document.kbId,
          ordinal: entry.chunk.ordinal,
          modality: document.modality,
          source: entry.chunk.source,
          text: entry.text,
          page: entry.chunk.page,
          charStart: entry.chunk.charStart,
          charEnd: entry.chunk.charEnd,
          tsStart: entry.chunk.tsStart,
          tsEnd: entry.chunk.tsEnd,
          imagePath: entry.chunk.imagePath,
          qdrantPointId: entry.id,
        })),
      );

      await tx
        .update(documents)
        .set({
          status: 'indexed',
          error: null,
          pageCount: extracted.pageCount,
          durationSec: extracted.durationSec,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, document.id));
    });

    await report(document, 'completed', `${rows.length} chunks indexed`);
  } catch (cause) {
    const message = toError(cause).message;
    await db
      .update(documents)
      .set({ status: 'failed', error: message, updatedAt: new Date() })
      .where(eq(documents.id, documentId));
    await report(document, 'failed', undefined, message);
    throw cause;
  }
}
