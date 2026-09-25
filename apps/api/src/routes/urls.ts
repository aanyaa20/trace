import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ingestUrlRequestSchema, type UploadAccepted } from '@trace/contracts';
import { db } from '../db/client.js';
import { documents, knowledgeBases } from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import { enqueueIngestion } from '../queue/queues.js';
import { persistBuffer, safeFilename, storagePathFor } from '../services/storage.js';
import { htmlToText } from '../services/html.js';
import { fetchPublicUrl } from '../services/urlFetch.js';

const params = z.object({ id: z.string().uuid() });

function filenameFor(url: string, contentType: string): string {
  const parsed = new URL(url);
  const last = parsed.pathname.split('/').filter(Boolean).pop();
  const extension = contentType === 'application/pdf' ? '.pdf' : '.txt';
  const base = safeFilename(last ?? parsed.hostname);
  return base.includes('.') ? base : `${base}${extension}`;
}

export default async function urlRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.requireAuth);

  app.post('/kb/:id/urls', async (request, reply) => {
    const { id: kbId } = params.parse(request.params);
    const { url, title } = ingestUrlRequestSchema.parse(request.body);

    const [owned] = await db
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.userId, request.session.sub)));
    if (!owned) throw notFound('knowledge base');

    // Validates the host, every redirect hop, the content type and the size.
    const fetched = await fetchPublicUrl(url);

    const isPdf = fetched.contentType === 'application/pdf';
    const body = isPdf
      ? fetched.body
      : Buffer.from(
          fetched.contentType === 'text/html'
            ? htmlToText(fetched.body.toString('utf8'))
            : fetched.body.toString('utf8'),
          'utf8',
        );

    if (body.byteLength === 0) throw badRequest(`no readable content at ${fetched.finalUrl}`);

    const documentId = randomUUID();
    const filename = title ? safeFilename(title) : filenameFor(fetched.finalUrl, fetched.contentType);
    const storagePath = storagePathFor(kbId, documentId, filename);
    const sizeBytes = await persistBuffer(body, storagePath);

    await db.insert(documents).values({
      id: documentId,
      kbId,
      filename,
      storagePath,
      mime: isPdf ? 'application/pdf' : 'text/plain',
      sizeBytes,
      modality: isPdf ? 'pdf' : 'text',
      status: 'queued',
      sourceUrl: fetched.finalUrl,
    });

    await enqueueIngestion({ documentId, kbId });

    const accepted: UploadAccepted = {
      documents: [{ id: documentId, filename, status: 'queued' }],
    };
    return reply.status(202).send(accepted);
  });
}
