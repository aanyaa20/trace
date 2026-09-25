import { and, asc, count, desc, eq, inArray, max, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createConversationRequestSchema,
  postMessageRequestSchema,
  retrievalModeSchema,
  type Conversation,
  type ConversationList,
  type ConversationSummary,
  type Message,
  type PostMessageResponse,
} from '@trace/contracts';
import { db } from '../db/client.js';
import { conversations, knowledgeBases, messages } from '../db/schema.js';
import { badRequest, notFound, toError } from '../errors.js';
import { runAgent } from '../agent/graph.js';
import type { ConversationTurn } from '../agent/state.js';
import { SseStream } from '../services/sse.js';

const kbParams = z.object({ id: z.string().uuid() });
const conversationParams = z.object({ conversationId: z.string().uuid() });
const messageParams = z.object({ messageId: z.string().uuid() });
const modeQuery = z.object({ mode: retrievalModeSchema.optional() });

/** Turns handed to the agent for reference resolution. The analyse node
 *  trims further; this bound is here so a long thread cannot grow the query
 *  the database returns without limit. */
const HISTORY_TURNS = 8;

/** A title is generated from the first question, so it has to be short enough
 *  to read in a switcher. */
const TITLE_CHARS = 60;

/** Mirrors the column default in the schema. A thread still carrying it has
 *  never been named, by the user or by its first question. */
const DEFAULT_TITLE = 'New conversation';

/** The same shortening the first question gets when it names a new thread. */
function titleFrom(question: string | undefined): string | null {
  const trimmed = question?.trim();
  if (!trimmed) return null;
  const short = trimmed.slice(0, TITLE_CHARS);
  return short.length < trimmed.length ? `${short}\u2026` : short;
}

async function loadOwnedConversation(conversationId: string, userId: string) {
  const [row] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));
  if (!row) throw notFound('conversation');
  return row;
}

/**
 * Completed turns before this question, oldest first.
 *
 * Only complete messages qualify. A pending or failed assistant row has no
 * answer, and a half-written one would describe the thread as the model never
 * left it. The current question is excluded by id rather than by timestamp:
 * two messages inserted in one transaction can share a timestamp, and a
 * question that resolved against itself would be circular.
 */
async function loadHistory(conversationId: string, excludeId: string): Promise<ConversationTurn[]> {
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.status, 'complete'),
        ne(messages.id, excludeId),
      ),
    )
    .orderBy(asc(messages.createdAt), sql`case when ${messages.role} = 'user' then 0 else 1 end`);

  return rows
    .filter((row) => row.content.trim().length > 0)
    .slice(-HISTORY_TURNS)
    .map((row) => ({ role: row.role, content: row.content }));
}

export default async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.requireAuth);

  app.post('/kb/:id/conversations', async (request, reply) => {
    const { id: kbId } = kbParams.parse(request.params);
    const { title } = createConversationRequestSchema
      .omit({ kbId: true })
      .parse(request.body ?? {});

    const [owned] = await db
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.userId, request.session.sub)));
    if (!owned) throw notFound('knowledge base');

    const [created] = await db
      .insert(conversations)
      .values({ kbId, userId: request.session.sub, ...(title ? { title } : {}) })
      .returning();
    if (!created) throw notFound('conversation');

    const body: Conversation = {
      id: created.id,
      kbId: created.kbId,
      title: created.title,
      createdAt: created.createdAt.toISOString(),
    };
    return reply.status(201).send(body);
  });

  /**
   * Threads in this knowledge base, most recently active first. A thread with
   * no messages sorts on its creation time, which is what keeps a freshly
   * opened one at the top of the switcher instead of at the bottom.
   */
  app.get('/kb/:id/conversations', async (request) => {
    const { id: kbId } = kbParams.parse(request.params);

    const rows = await db
      .select({
        conversation: conversations,
        messageCount: count(messages.id),
        lastMessageAt: max(messages.createdAt),
      })
      .from(conversations)
      .leftJoin(messages, eq(messages.conversationId, conversations.id))
      .where(and(eq(conversations.kbId, kbId), eq(conversations.userId, request.session.sub)))
      .groupBy(conversations.id);

    // The first question is what a reader recognises a thread by, and it is
    // one query for all of them rather than one per thread.
    const previews = new Map<string, string>();
    if (rows.length > 0) {
      const firstQuestions = await db
        .select({
          conversationId: messages.conversationId,
          content: messages.content,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(
          and(
            inArray(
              messages.conversationId,
              rows.map((row) => row.conversation.id),
            ),
            eq(messages.role, 'user'),
          ),
        )
        .orderBy(asc(messages.createdAt));

      for (const question of firstQuestions) {
        if (!previews.has(question.conversationId)) {
          previews.set(question.conversationId, question.content);
        }
      }
    }

    const summaries: ConversationSummary[] = rows
      .map((row) => ({
        id: row.conversation.id,
        kbId: row.conversation.kbId,
        // Threads that predate auto-titling still carry the default, and a
        // list where every row reads "New conversation" is a list you cannot
        // use. The first question names them here rather than in a migration,
        // so the fallback also covers a thread whose title was never set for
        // any other reason.
        title:
          row.conversation.title === DEFAULT_TITLE
            ? titleFrom(previews.get(row.conversation.id)) ?? row.conversation.title
            : row.conversation.title,
        createdAt: row.conversation.createdAt.toISOString(),
        lastMessageAt: row.lastMessageAt ? new Date(row.lastMessageAt).toISOString() : null,
        messageCount: Number(row.messageCount),
        preview: previews.get(row.conversation.id) ?? null,
      }))
      .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));

    const body: ConversationList = { conversations: summaries };
    return body;
  });

  app.delete('/chat/:conversationId', async (request, reply) => {
    const { conversationId } = conversationParams.parse(request.params);
    await loadOwnedConversation(conversationId, request.session.sub);
    // Messages cascade from the conversation row.
    await db.delete(conversations).where(eq(conversations.id, conversationId));
    return reply.status(204).send();
  });

  /**
   * Records the question and reserves the assistant message. The loop itself
   * runs when the client opens the stream, so the work happens exactly once
   * and its output has somewhere to go.
   */
  app.post('/chat/:conversationId/messages', async (request, reply) => {
    const { conversationId } = conversationParams.parse(request.params);
    const { mode: queryMode } = modeQuery.parse(request.query);
    const parsed = postMessageRequestSchema.parse(request.body);
    const mode = queryMode ?? parsed.mode;

    const conversation = await loadOwnedConversation(conversationId, request.session.sub);

    const [assistant] = await db.transaction(async (tx) => {
      await tx.insert(messages).values({
        conversationId,
        role: 'user',
        content: parsed.query,
        status: 'complete',
      });

      // A thread the user has to recognise later needs a name, and the first
      // question is the only one available without spending a model call on
      // it. A title the user set is never overwritten.
      if (conversation.title === DEFAULT_TITLE) {
        const title = parsed.query.trim().slice(0, TITLE_CHARS);
        await tx
          .update(conversations)
          .set({ title: title.length < parsed.query.trim().length ? `${title}\u2026` : title })
          .where(and(eq(conversations.id, conversationId), eq(conversations.title, DEFAULT_TITLE)));
      }

      return tx
        .insert(messages)
        .values({
          conversationId,
          role: 'assistant',
          content: '',
          mode,
          status: 'pending',
          ...(parsed.documentId ? { documentId: parsed.documentId } : {}),
        })
        .returning({ id: messages.id });
    });

    if (!assistant) throw notFound('message');

    const body: PostMessageResponse = {
      messageId: assistant.id,
      conversationId,
      streamUrl: `/chat/stream/${assistant.id}`,
    };
    return reply.status(202).send(body);
  });

  app.get('/chat/stream/:messageId', async (request, reply) => {
    const { messageId } = messageParams.parse(request.params);

    const [row] = await db
      .select({ message: messages, conversation: conversations })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(messages.id, messageId));

    if (!row || row.conversation.userId !== request.session.sub) throw notFound('message');
    if (row.message.status !== 'pending') {
      throw badRequest(`message ${messageId} has already been ${row.message.status}`);
    }

    const [question] = await db
      .select({ id: messages.id, content: messages.content })
      .from(messages)
      .where(and(eq(messages.conversationId, row.conversation.id), eq(messages.role, 'user')))
      .orderBy(desc(messages.createdAt))
      .limit(1);

    if (!question) throw badRequest('no question found for this message');

    // Earlier turns are read here rather than inside the agent so that the
    // loop keeps one input contract: the harness runs it with no conversation
    // at all, and nothing about a scored run depends on a database it does not
    // own.
    const history = await loadHistory(row.conversation.id, question.id);

    await db.update(messages).set({ status: 'streaming' }).where(eq(messages.id, messageId));

    const stream = new SseStream(reply);
    const controller = new AbortController();
    // A client that closes the tab must not leave a grading fan-out running.
    stream.onClientDisconnect(() => controller.abort());

    const started = Date.now();
    try {
      const result = await runAgent({
        kbId: row.conversation.kbId,
        query: question.content,
        mode: row.message.mode ?? 'agentic',
        history,
        documentId: row.message.documentId,
        signal: controller.signal,
        onEvent: (event) => stream.send('agent', { type: 'agent', event }),
        onToken: (text) => stream.send('token', { type: 'token', text }),
      });

      stream.send('citations', { type: 'citations', citations: result.citations });
      stream.send('done', {
        type: 'done',
        messageId,
        abstained: result.abstained,
        answer: result.answer,
        trace: result.trace,
      });

      await db
        .update(messages)
        .set({
          content: result.answer,
          citations: result.citations,
          trace: result.trace,
          abstained: result.abstained,
          status: 'complete',
          latencyMs: Date.now() - started,
        })
        .where(eq(messages.id, messageId));
    } catch (cause) {
      const message = toError(cause).message;
      request.log.error({ err: cause, messageId }, 'agent run failed');
      stream.send('error', { type: 'error', code: 'agent_failed', message });
      await db
        .update(messages)
        .set({ status: 'failed', error: message, latencyMs: Date.now() - started })
        .where(eq(messages.id, messageId));
    } finally {
      stream.close();
    }

    return reply;
  });

  app.get('/chat/:conversationId/messages', async (request) => {
    const { conversationId } = conversationParams.parse(request.params);
    await loadOwnedConversation(conversationId, request.session.sub);

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      // A turn's question and its answer share a createdAt to the
      // millisecond, so the timestamp alone leaves their order to the planner.
      // The role breaks the tie: nobody answers before they are asked.
      .orderBy(asc(messages.createdAt), sql`case when ${messages.role} = 'user' then 0 else 1 end`);

    return {
      messages: rows.map((row): Message => ({
        id: row.id,
        conversationId: row.conversationId,
        role: row.role,
        content: row.content,
        mode: row.mode,
        abstained: row.abstained,
        citations: row.citations,
        trace: row.trace ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  });
}
