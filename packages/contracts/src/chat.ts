import { z } from 'zod';
import { retrievalModeSchema } from './common.js';
import { citationSchema } from './citations.js';
import { agentEventSchema, agentTraceSchema } from './agent.js';

export const createConversationRequestSchema = z.object({
  kbId: z.string().uuid(),
  title: z.string().max(200).optional(),
});
export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>;

export const conversationSchema = z.object({
  id: z.string().uuid(),
  kbId: z.string().uuid(),
  title: z.string(),
  createdAt: z.string().datetime(),
});
export type Conversation = z.infer<typeof conversationSchema>;

/**
 * A thread as the switcher needs it: enough to choose between threads without
 * loading any of them. `preview` is the first question asked, which is what a
 * reader recognises a thread by.
 */
export const conversationSummarySchema = z.object({
  id: z.string().uuid(),
  kbId: z.string().uuid(),
  title: z.string(),
  createdAt: z.string().datetime(),
  lastMessageAt: z.string().datetime().nullable(),
  messageCount: z.number().int().nonnegative(),
  preview: z.string().nullable(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationListSchema = z.object({
  conversations: z.array(conversationSummarySchema),
});
export type ConversationList = z.infer<typeof conversationListSchema>;

export const postMessageRequestSchema = z.object({
  query: z.string().min(1).max(4000),
  mode: retrievalModeSchema.default('agentic'),
  /**
   * Restricts retrieval to one document. Set when the reader has a document
   * open and the question is about that document — "what kind of document is
   * this?" names nothing a retriever can match, so without this the search
   * ranges over the whole corpus and answers about whatever scored best.
   */
  documentId: z.string().uuid().optional(),
});
export type PostMessageRequest = z.infer<typeof postMessageRequestSchema>;

export const postMessageResponseSchema = z.object({
  messageId: z.string().uuid(),
  conversationId: z.string().uuid(),
  streamUrl: z.string(),
});
export type PostMessageResponse = z.infer<typeof postMessageResponseSchema>;

export const messageRoleSchema = z.enum(['user', 'assistant']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const messageSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  role: messageRoleSchema,
  content: z.string(),
  mode: retrievalModeSchema.nullable(),
  abstained: z.boolean(),
  citations: z.array(citationSchema),
  trace: agentTraceSchema.nullable(),
  createdAt: z.string().datetime(),
});
export type Message = z.infer<typeof messageSchema>;

/**
 * Frames on GET /chat/stream/:messageId. Agent frames arrive alone until
 * synthesis starts, then token frames stream, then one citations frame,
 * then done. An error frame may replace any of them and always ends the
 * stream.
 */
export const chatStreamFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agent'), event: agentEventSchema }),
  z.object({ type: z.literal('token'), text: z.string() }),
  z.object({ type: z.literal('citations'), citations: z.array(citationSchema) }),
  z.object({
    type: z.literal('done'),
    messageId: z.string().uuid(),
    abstained: z.boolean(),
    /**
     * The authoritative answer after citation resolution. Streamed tokens are
     * provisional: an answer whose citations all fail verification is replaced
     * by an abstention, and the client must render this instead of the text it
     * accumulated.
     */
    answer: z.string(),
    trace: agentTraceSchema,
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ChatStreamFrame = z.infer<typeof chatStreamFrameSchema>;
