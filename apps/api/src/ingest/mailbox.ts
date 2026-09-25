import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AddressObject, ParsedMail } from 'mailparser';
import type { SyncResult } from '@trace/contracts';
import { db } from '../db/client.js';
import { connectors, documents } from '../db/schema.js';
import { env } from '../env.js';
import { notFound, toError } from '../errors.js';
import { logger } from '../logger.js';
import { enqueueIngestion } from '../queue/queues.js';
import { htmlToText } from '../services/html.js';
import { fetchSince, type FetchedMessage } from '../services/imap.js';
import { unseal } from '../services/secretBox.js';
import { modalityForMime, persistBuffer, storagePathFor } from '../services/storage.js';

function addresses(value: AddressObject | AddressObject[] | undefined): string {
  if (!value) return '';
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((entry) => entry.value)
    .map((entry) => (entry.name ? `${entry.name} <${entry.address ?? ''}>` : (entry.address ?? '')))
    .filter(Boolean)
    .join(', ');
}

/**
 * Renders a message as the text that gets chunked and embedded.
 *
 * The headers are part of the body on purpose. A chunk that says only "yes,
 * approved, go ahead" is useless as evidence; the same chunk carrying its
 * sender and date answers "who approved this, and when". It also makes the
 * sender and the date retrievable, so "what did Priya say about the deadline"
 * matches on the header line rather than relying on metadata filtering the
 * retriever does not have.
 */
function render(parsed: ParsedMail): string {
  const body =
    parsed.text?.trim() || (parsed.html ? htmlToText(parsed.html) : '') || '';

  const headers = [
    `From: ${addresses(parsed.from)}`,
    `To: ${addresses(parsed.to)}`,
    parsed.cc ? `Cc: ${addresses(parsed.cc)}` : null,
    `Date: ${parsed.date ? parsed.date.toISOString() : 'unknown'}`,
    `Subject: ${parsed.subject ?? '(no subject)'}`,
  ].filter(Boolean);

  return `${headers.join('\n')}\n\n${body}`.trim();
}

/** A readable title for the documents list; the storage path is sanitised
 *  separately by storagePathFor. */
function titleOf(parsed: ParsedMail): string {
  const subject = parsed.subject?.trim() || '(no subject)';
  const sender = parsed.from?.value?.[0];
  const who = sender?.name || sender?.address || 'unknown sender';
  return `${subject} — ${who}`.slice(0, 200);
}

interface Insert {
  documentId: string;
  kbId: string;
}

async function insertDocument(row: {
  kbId: string;
  connectorId: string;
  externalId: string;
  filename: string;
  body: Buffer;
  mime: string;
}): Promise<Insert | null> {
  const documentId = randomUUID();
  const storagePath = storagePathFor(row.kbId, documentId, row.filename);

  let modality;
  try {
    modality = modalityForMime(row.mime);
  } catch {
    return null; // A mime the pipeline has no extractor for.
  }

  // The unique index on (connector_id, external_id) is what makes a re-sync
  // idempotent, including after a UIDVALIDITY reset forces the cursor back to
  // the start. The insert is attempted before the file is written so a losing
  // race leaves no orphan on disk.
  const [inserted] = await db
    .insert(documents)
    .values({
      id: documentId,
      kbId: row.kbId,
      filename: row.filename,
      storagePath,
      mime: row.mime,
      sizeBytes: row.body.byteLength,
      modality,
      status: 'queued',
      connectorId: row.connectorId,
      externalId: row.externalId,
    })
    .onConflictDoNothing()
    .returning({ id: documents.id });

  if (!inserted) return null;

  await persistBuffer(row.body, storagePath);
  return { documentId, kbId: row.kbId };
}

async function importMessage(
  message: FetchedMessage,
  connector: { id: string; kbId: string; includeAttachments: boolean },
): Promise<{ inserts: Insert[]; attachments: number; skipped: number }> {
  const { parsed, uid } = message;
  // Message-ID is the stable identity across mailboxes and folders; UID is only
  // a fallback for the rare message that arrives without one.
  const identity = parsed.messageId?.trim() || `uid:${uid}`;
  const inserts: Insert[] = [];
  let attachments = 0;
  let skipped = 0;

  const text = render(parsed);
  if (text.length > 0) {
    const body = await insertDocument({
      kbId: connector.kbId,
      connectorId: connector.id,
      externalId: identity,
      filename: `${titleOf(parsed)}.txt`,
      body: Buffer.from(text, 'utf8'),
      mime: 'text/plain',
    });
    if (body) inserts.push(body);
    else skipped += 1;
  }

  if (connector.includeAttachments) {
    for (const [index, attachment] of parsed.attachments.entries()) {
      if (attachment.content.byteLength > env.MAILBOX_MAX_ATTACHMENT_BYTES) {
        skipped += 1;
        continue;
      }

      // Every attachment becomes a document in its own right, which is the
      // point of connecting a mailbox at all: the PDFs, scans and voice notes
      // already flow through the OCR, CLIP and whisper pipeline unchanged.
      const inserted = await insertDocument({
        kbId: connector.kbId,
        connectorId: connector.id,
        externalId: `${identity}#${index}`,
        filename: attachment.filename?.trim() || `attachment-${index + 1}`,
        body: attachment.content,
        mime: attachment.contentType || 'application/octet-stream',
      });

      if (inserted) {
        inserts.push(inserted);
        attachments += 1;
      } else {
        skipped += 1;
      }
    }
  }

  return { inserts, attachments, skipped };
}

/**
 * One sync pass. Returns after at most MAILBOX_BATCH_SIZE messages so a first
 * import of a large mailbox cannot occupy the worker indefinitely; the
 * remainder is picked up by the next poll, or immediately when more was left
 * waiting.
 */
export async function syncConnector(connectorId: string): Promise<SyncResult> {
  const [connector] = await db.select().from(connectors).where(eq(connectors.id, connectorId));
  if (!connector) throw notFound('connector');

  await db
    .update(connectors)
    .set({ status: 'syncing', error: null, updatedAt: new Date() })
    .where(eq(connectors.id, connectorId));

  try {
    const result = await fetchSince(
      {
        host: connector.host,
        port: connector.port,
        user: connector.label,
        password: unseal(connector.secret),
        mailbox: connector.mailbox,
      },
      {
        uidValidity: connector.uidValidity,
        lastUid: connector.lastUid,
        sinceDays: connector.sinceDays,
      },
    );

    let messages = 0;
    let attachments = 0;
    let skipped = 0;
    const queued: Insert[] = [];

    for (const message of result.messages) {
      const imported = await importMessage(message, {
        id: connector.id,
        kbId: connector.kbId,
        includeAttachments: connector.includeAttachments,
      });
      if (imported.inserts.length > 0) messages += 1;
      attachments += imported.attachments;
      skipped += imported.skipped;
      queued.push(...imported.inserts);
    }

    // The watermark is written before the ingestion jobs are enqueued: a crash
    // between the two loses embeddings for messages that are already stored,
    // which a re-ingest fixes, whereas the reverse loses the cursor and
    // re-downloads the mailbox.
    await db
      .update(connectors)
      .set({
        status: 'idle',
        error: null,
        uidValidity: result.uidValidity,
        lastUid: result.lastUid,
        messagesImported: connector.messagesImported + messages,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(connectors.id, connectorId));

    for (const job of queued) {
      await enqueueIngestion({ documentId: job.documentId, kbId: job.kbId });
    }

    logger.info(
      { connectorId, messages, attachments, skipped, more: result.more },
      'mailbox sync finished',
    );

    return { connectorId, messages, attachments, skipped };
  } catch (cause) {
    const error = toError(cause);
    await db
      .update(connectors)
      .set({ status: 'failed', error: error.message, updatedAt: new Date() })
      .where(eq(connectors.id, connectorId));
    throw error;
  }
}
