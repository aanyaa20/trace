import { z } from 'zod';

/**
 * A connector is a mailbox the corpus keeps reading. Only IMAP exists today:
 * the Gmail API needs a verified OAuth app for its restricted scopes, and an
 * unverified one hands back refresh tokens that expire after seven days, which
 * is not a thing a continuously syncing service can be built on. An app
 * password over IMAP has none of that and costs nothing.
 */
export const connectorKindSchema = z.enum(['imap']);
export type ConnectorKind = z.infer<typeof connectorKindSchema>;

export const connectorStatusSchema = z.enum(['idle', 'syncing', 'failed']);
export type ConnectorStatus = z.infer<typeof connectorStatusSchema>;

/** What a client may see. The credential is never part of this shape. */
export const connectorSchema = z.object({
  id: z.string().uuid(),
  kbId: z.string().uuid(),
  kind: connectorKindSchema,
  /** The mailbox address, shown so a reader knows whose mail this corpus holds. */
  label: z.string(),
  host: z.string(),
  mailbox: z.string(),
  includeAttachments: z.boolean(),
  status: connectorStatusSchema,
  error: z.string().nullable(),
  messagesImported: z.number().int().nonnegative(),
  lastSyncedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Connector = z.infer<typeof connectorSchema>;

export const connectorListSchema = z.object({ connectors: z.array(connectorSchema) });
export type ConnectorList = z.infer<typeof connectorListSchema>;

export const createConnectorRequestSchema = z.object({
  kind: connectorKindSchema.default('imap'),
  email: z.string().email(),
  /** A Gmail app password, not the account password. Sixteen characters. */
  appPassword: z.string().min(8).max(200),
  host: z.string().min(1).max(255).default('imap.gmail.com'),
  port: z.coerce.number().int().positive().max(65535).default(993),
  mailbox: z.string().min(1).max(255).default('INBOX'),
  /** How far back the first sync reaches. Later syncs are incremental. */
  sinceDays: z.coerce.number().int().min(1).max(3650).default(90),
  includeAttachments: z.boolean().default(true),
});
export type CreateConnectorRequest = z.infer<typeof createConnectorRequestSchema>;

export const syncResultSchema = z.object({
  connectorId: z.string().uuid(),
  messages: z.number().int().nonnegative(),
  attachments: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type SyncResult = z.infer<typeof syncResultSchema>;
