import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AgentTrace, Citation } from '@trace/contracts';

export const modalityEnum = pgEnum('modality', ['text', 'pdf', 'image', 'audio', 'video']);
export const documentStatusEnum = pgEnum('document_status', [
  'queued',
  'processing',
  'indexed',
  'failed',
]);
export const blockSourceEnum = pgEnum('block_source', ['text', 'ocr', 'asr', 'caption']);
export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant']);
export const retrievalModeEnum = pgEnum('retrieval_mode', ['agentic', 'naive']);
export const connectorKindEnum = pgEnum('connector_kind', ['imap']);
export const connectorStatusEnum = pgEnum('connector_status', ['idle', 'syncing', 'failed']);
export const messageStatusEnum = pgEnum('message_status', [
  'pending',
  'streaming',
  'complete',
  'failed',
]);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

export const knowledgeBases = pgTable(
  'knowledge_bases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('knowledge_bases_user_id_idx').on(t.userId)],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kbId: uuid('kb_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    /** Path on the shared uploads volume. Never returned to a client. */
    storagePath: text('storage_path').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    modality: modalityEnum('modality').notNull(),
    status: documentStatusEnum('status').notNull().default('queued'),
    error: text('error'),
    pageCount: integer('page_count'),
    durationSec: real('duration_sec'),
    /** Set when the document arrived through POST /kb/:id/urls. */
    sourceUrl: text('source_url'),
    /** Set when the document was pulled from a mailbox rather than uploaded. */
    connectorId: uuid('connector_id').references(() => connectors.id, { onDelete: 'set null' }),
    /**
     * Identity at the source: a message's Message-ID, or that plus an
     * attachment index. The same mail forwarded twice is one document, and a
     * re-sync after a watermark reset imports nothing new.
     */
    externalId: text('external_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('documents_kb_id_idx').on(t.kbId),
    index('documents_status_idx').on(t.status),
    // Postgres treats NULLs as distinct, so uploaded documents (no connector)
    // never collide here.
    uniqueIndex('documents_connector_external_key').on(t.connectorId, t.externalId),
  ],
);

/**
 * A mailbox this knowledge base keeps reading. The credential is an app
 * password sealed with AES-256-GCM (see services/secretBox.ts) and is never
 * returned by any route.
 */
export const connectors = pgTable(
  'connectors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kbId: uuid('kb_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    kind: connectorKindEnum('kind').notNull().default('imap'),
    label: text('label').notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull(),
    mailbox: text('mailbox').notNull().default('INBOX'),
    secret: text('secret').notNull(),
    includeAttachments: boolean('include_attachments').notNull().default(true),
    sinceDays: integer('since_days').notNull().default(90),
    /**
     * IMAP's own watermark pair. UIDs are only meaningful while UIDVALIDITY is
     * unchanged; when the server changes it the whole numbering is void and the
     * cursor has to restart, which is why both are stored together.
     */
    uidValidity: text('uid_validity'),
    lastUid: integer('last_uid').notNull().default(0),
    status: connectorStatusEnum('status').notNull().default('idle'),
    error: text('error'),
    messagesImported: integer('messages_imported').notNull().default(0),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('connectors_kb_id_idx').on(t.kbId)],
);

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    /** Denormalised from documents so kb-scoped filters and deletes stay cheap. */
    kbId: uuid('kb_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    modality: modalityEnum('modality').notNull(),
    source: blockSourceEnum('source').notNull().default('text'),
    text: text('text').notNull(),
    page: integer('page'),
    charStart: integer('char_start'),
    charEnd: integer('char_end'),
    tsStart: real('ts_start'),
    tsEnd: real('ts_end'),
    imagePath: text('image_path'),
    /** Qdrant accepts only uuid or unsigned int ids; this mirrors chunks.id. */
    qdrantPointId: uuid('qdrant_point_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chunks_document_ordinal_key').on(t.documentId, t.ordinal),
    index('chunks_kb_id_idx').on(t.kbId),
  ],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kbId: uuid('kb_id')
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('New conversation'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('conversations_kb_id_idx').on(t.kbId)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull().default(''),
    mode: retrievalModeEnum('mode'),
    /**
     * Set when the question was asked about one open document. Persisted
     * rather than passed through, because a question is posted on one request
     * and streamed on another, and the scope has to survive between them.
     * Nulled by the delete, not cascaded: losing a document should not delete
     * the record of what was asked about it.
     */
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
    status: messageStatusEnum('status').notNull().default('complete'),
    abstained: boolean('abstained').notNull().default(false),
    error: text('error'),
    citations: jsonb('citations').$type<Citation[]>().notNull().default([]),
    trace: jsonb('trace').$type<AgentTrace | null>(),
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_id_idx').on(t.conversationId)],
);

export const evalRuns = pgTable('eval_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  kbId: uuid('kb_id')
    .notNull()
    .references(() => knowledgeBases.id, { onDelete: 'cascade' }),
  dataset: text('dataset').notNull(),
  mode: retrievalModeEnum('mode').notNull(),
  notes: text('notes'),
  /** Threshold sweep needs the settings a run used, not just its scores. */
  config: jsonb('config').$type<Record<string, number | string>>(),
  metrics: jsonb('metrics').$type<Record<string, number>>(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export const evalResults = pgTable(
  'eval_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    expected: text('expected'),
    answer: text('answer').notNull(),
    abstained: boolean('abstained').notNull().default(false),
    citations: jsonb('citations').$type<Citation[]>().notNull().default([]),
    scores: jsonb('scores').$type<Record<string, number>>().notNull().default({}),
    latencyMs: integer('latency_ms'),
  },
  (t) => [index('eval_results_run_id_idx').on(t.runId)],
);
