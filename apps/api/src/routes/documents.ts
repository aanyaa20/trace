import { randomUUID } from 'node:crypto';
import { and, count, countDistinct, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Document, DocumentList, UploadAccepted } from '@trace/contracts';
import { db } from '../db/client.js';
import { chunks, documents, knowledgeBases } from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import { enqueueIngestion } from '../queue/queues.js';
import { modalityForMime, persistStream, removeStoredFile, safeFilename, storagePathFor } from '../services/storage.js';
import { COLLECTION, qdrant } from '../qdrant/client.js';

const kbParams = z.object({ id: z.string().uuid() });
const documentParams = z.object({ id: z.string().uuid() });

async function assertOwnedKb(kbId: string, userId: string): Promise<void> {
  const [owned] = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.userId, userId)));
  if (!owned) throw notFound('knowledge base');
}

async function loadOwnedDocument(documentId: string, userId: string) {
  const [row] = await db
    .select({ document: documents, ownerId: knowledgeBases.userId })
    .from(documents)
    .innerJoin(knowledgeBases, eq(knowledgeBases.id, documents.kbId))
    .where(eq(documents.id, documentId));

  if (!row || row.ownerId !== userId) throw notFound('document');
  return row.document;
}

export default async function documentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.requireAuth);

  app.post('/kb/:id/documents', async (request, reply) => {
    const { id: kbId } = kbParams.parse(request.params);
    await assertOwnedKb(kbId, request.session.sub);

    const accepted: UploadAccepted['documents'] = [];

    // Parts are consumed as a stream: the file is written to the shared volume
    // as it arrives, so a 500 MB video never exists in the heap.
    for await (const part of request.parts()) {
      if (part.type !== 'file') continue;

      const filename = safeFilename(part.filename ?? 'upload');
      const mime = part.mimetype || 'application/octet-stream';
      const modality = modalityForMime(mime);
      const documentId = randomUUID();
      const storagePath = storagePathFor(kbId, documentId, filename);

      const sizeBytes = await persistStream(part.file, storagePath);
      if (part.file.truncated) {
        await removeStoredFile(storagePath);
        throw badRequest(`${filename} exceeds MAX_UPLOAD_BYTES`);
      }

      await db.insert(documents).values({
        id: documentId,
        kbId,
        filename,
        storagePath,
        mime,
        sizeBytes,
        modality,
        status: 'queued',
      });

      await enqueueIngestion({ documentId, kbId });
      accepted.push({ id: documentId, filename, status: 'queued' });
    }

    if (accepted.length === 0) throw badRequest('no file part was present in the upload');

    const body: UploadAccepted = { documents: accepted };
    return reply.status(202).send(body);
  });

  app.get('/kb/:id/documents', async (request) => {
    const { id: kbId } = kbParams.parse(request.params);
    await assertOwnedKb(kbId, request.session.sub);

    const rows = await db
      .select({
        document: documents,
        chunkCount: count(chunks.id),
        renderedPages: countDistinct(chunks.imagePath),
      })
      .from(documents)
      .leftJoin(chunks, eq(chunks.documentId, documents.id))
      .where(eq(documents.kbId, kbId))
      .groupBy(documents.id)
      .orderBy(desc(documents.createdAt));

    const body: DocumentList = {
      documents: rows.map(({ document, chunkCount, renderedPages }): Document => ({
        id: document.id,
        kbId: document.kbId,
        filename: document.filename,
        mime: document.mime,
        sizeBytes: document.sizeBytes,
        modality: document.modality,
        status: document.status,
        error: document.error,
        pageCount: document.pageCount,
        durationSec: document.durationSec,
        chunkCount: Number(chunkCount),
        renderedPages: Number(renderedPages),
        sourceUrl: document.sourceUrl,
        connectorId: document.connectorId,
        createdAt: document.createdAt.toISOString(),
        updatedAt: document.updatedAt.toISOString(),
      })),
    };
    return body;
  });

  app.delete('/documents/:id', async (request, reply) => {
    const { id } = documentParams.parse(request.params);
    const document = await loadOwnedDocument(id, request.session.sub);

    // Vectors go first: a leftover Postgres row is visible and fixable, while
    // a leftover vector would surface as a citation to a deleted document.
    await qdrant.delete(COLLECTION, {
      wait: true,
      filter: { must: [{ key: 'document_id', match: { value: id } }] },
    });

    await db.delete(documents).where(eq(documents.id, id));
    await removeStoredFile(document.storagePath);

    return reply.status(204).send();
  });
}
