import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { chunks, documents, knowledgeBases } from '../db/schema.js';
import { badRequest, notFound } from '../errors.js';
import { env } from '../env.js';

const params = z.object({ id: z.string().uuid() });
const query = z.object({ page: z.coerce.number().int().positive().optional() });

function assertInsideUploads(candidate: string): string {
  const root = path.resolve(env.UPLOAD_DIR);
  const resolved = path.resolve(candidate);
  // Paths come from our own rows, but a traversal here would serve any file
  // the container can read, so the check is unconditional.
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw badRequest('preview path is outside the upload directory');
  }
  return resolved;
}

export default async function previewRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.requireAuth);

  /**
   * Serves the bytes behind a document. Range requests are honoured so a
   * browser can seek inside audio and video, which is what makes a timestamp
   * citation clickable.
   */
  app.get('/documents/:id/preview', async (request, reply) => {
    const { id } = params.parse(request.params);
    const { page } = query.parse(request.query);

    const [row] = await db
      .select({ document: documents, ownerId: knowledgeBases.userId })
      .from(documents)
      .innerJoin(knowledgeBases, eq(knowledgeBases.id, documents.kbId))
      .where(eq(documents.id, id));

    if (!row || row.ownerId !== request.session.sub) throw notFound('document');

    let filePath = row.document.storagePath;
    let contentType = row.document.mime;

    // A scanned page was rendered to PNG during extraction; serving that is
    // more useful than serving the whole PDF for a single-page citation.
    if (page !== undefined) {
      const [pageChunk] = await db
        .select({ imagePath: chunks.imagePath })
        .from(chunks)
        .where(and(eq(chunks.documentId, id), eq(chunks.page, page)));

      if (pageChunk?.imagePath) {
        filePath = pageChunk.imagePath;
        contentType = 'image/png';
      }
    }

    const resolved = assertInsideUploads(filePath);
    const stats = await stat(resolved).catch(() => null);
    if (!stats) throw notFound(`preview for document ${id}`);

    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Number(match[2]) : stats.size - 1;
        if (start <= end && end < stats.size) {
          return reply
            .status(206)
            .headers({
              'content-type': contentType,
              'content-range': `bytes ${start}-${end}/${stats.size}`,
              'accept-ranges': 'bytes',
              'content-length': String(end - start + 1),
            })
            .send(createReadStream(resolved, { start, end }));
        }
      }
    }

    return reply
      .headers({
        'content-type': contentType,
        'content-length': String(stats.size),
        'accept-ranges': 'bytes',
      })
      .send(createReadStream(resolved));
  });
}
