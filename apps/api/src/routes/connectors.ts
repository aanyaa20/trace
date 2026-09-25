import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createConnectorRequestSchema,
  type Connector,
  type ConnectorList,
} from '@trace/contracts';
import { db } from '../db/client.js';
import { connectors, knowledgeBases } from '../db/schema.js';
import { conflict, notFound } from '../errors.js';
import {
  enqueueMailboxSync,
  scheduleMailboxSync,
  unscheduleMailboxSync,
} from '../queue/queues.js';
import { verifyMailbox } from '../services/imap.js';
import { seal } from '../services/secretBox.js';

const kbParams = z.object({ id: z.string().uuid() });
const connectorParams = z.object({ id: z.string().uuid() });

type Row = typeof connectors.$inferSelect;

/** The credential never leaves the database, so the public shape is built by
 *  naming fields rather than spreading the row. */
function present(row: Row): Connector {
  return {
    id: row.id,
    kbId: row.kbId,
    kind: row.kind,
    label: row.label,
    host: row.host,
    mailbox: row.mailbox,
    includeAttachments: row.includeAttachments,
    status: row.status,
    error: row.error,
    messagesImported: row.messagesImported,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function ownedKb(kbId: string, userId: string): Promise<void> {
  const [owned] = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.userId, userId)));
  if (!owned) throw notFound('knowledge base');
}

async function ownedConnector(connectorId: string, userId: string): Promise<Row> {
  const [row] = await db
    .select({ connector: connectors, ownerId: knowledgeBases.userId })
    .from(connectors)
    .innerJoin(knowledgeBases, eq(knowledgeBases.id, connectors.kbId))
    .where(eq(connectors.id, connectorId));

  if (!row || row.ownerId !== userId) throw notFound('connector');
  return row.connector;
}

export default async function connectorRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.requireAuth);

  app.get('/kb/:id/connectors', async (request) => {
    const { id: kbId } = kbParams.parse(request.params);
    await ownedKb(kbId, request.session.sub);

    const rows = await db
      .select()
      .from(connectors)
      .where(eq(connectors.kbId, kbId))
      .orderBy(desc(connectors.createdAt));

    const list: ConnectorList = { connectors: rows.map(present) };
    return list;
  });

  app.post('/kb/:id/connectors', async (request, reply) => {
    const { id: kbId } = kbParams.parse(request.params);
    await ownedKb(kbId, request.session.sub);

    const input = createConnectorRequestSchema.parse(request.body);

    const [existing] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.kbId, kbId), eq(connectors.label, input.email)));
    if (existing) throw conflict(`${input.email} is already connected to this knowledge base`);

    // Connect before storing. A wrong app password should fail here, where the
    // user can still read the error, rather than silently inside a poll.
    await verifyMailbox({
      host: input.host,
      port: input.port,
      user: input.email,
      password: input.appPassword,
      mailbox: input.mailbox,
    });

    const [created] = await db
      .insert(connectors)
      .values({
        kbId,
        kind: input.kind,
        label: input.email,
        host: input.host,
        port: input.port,
        mailbox: input.mailbox,
        secret: seal(input.appPassword),
        includeAttachments: input.includeAttachments,
        sinceDays: input.sinceDays,
      })
      .returning();

    if (!created) throw conflict('connector could not be created');

    await scheduleMailboxSync(created.id);
    await enqueueMailboxSync(created.id);

    return reply.status(201).send(present(created));
  });

  app.post('/connectors/:id/sync', async (request, reply) => {
    const { id } = connectorParams.parse(request.params);
    const row = await ownedConnector(id, request.session.sub);
    await enqueueMailboxSync(row.id);
    return reply.status(202).send(present(row));
  });

  app.delete('/connectors/:id', async (request, reply) => {
    const { id } = connectorParams.parse(request.params);
    const row = await ownedConnector(id, request.session.sub);

    // The schedule goes first: a poll that fires between the two would fail
    // looking up a row that no longer exists.
    await unscheduleMailboxSync(row.id);
    await db.delete(connectors).where(eq(connectors.id, row.id));

    // Documents already imported are left in place. They are part of the corpus
    // now, and answers already given cite them.
    return reply.status(204).send();
  });
}
