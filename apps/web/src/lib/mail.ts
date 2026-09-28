import type { Document } from '@trace/contracts';

/**
 * A mail pulled from a connected mailbox: the message itself, not one of its
 * attachments. Stored as a text document named "<subject> — <sender>.txt",
 * because that is what gets chunked and cited, but shown as the mail it is.
 */
export function isMail(document: Document): boolean {
  return document.connectorId !== null && document.parentId === null && document.mime.startsWith('text/');
}

/** Subject and sender, recovered from the stored name. */
export function mailParts(document: Document): { subject: string; sender: string | null } {
  const base = document.filename.replace(/\.txt$/i, '');
  const at = base.lastIndexOf(' — ');
  return at > 0 ? { subject: base.slice(0, at), sender: base.slice(at + 3) } : { subject: base, sender: null };
}

/** The name a reader knows the document by: a mail by its subject. */
export function displayName(document: Document): string {
  return isMail(document) ? mailParts(document).subject : document.filename;
}

/** Attachments grouped under the mail they arrived with. */
export function attachmentsByParent(documents: Document[]): Map<string, Document[]> {
  const byParent = new Map<string, Document[]>();
  for (const document of documents) {
    if (!document.parentId) continue;
    byParent.set(document.parentId, [...(byParent.get(document.parentId) ?? []), document]);
  }
  return byParent;
}

/** Documents that stand on their own in a list: everything except an
 *  attachment whose mail is in the same list, which is shown under it. */
export function topLevel(documents: Document[]): Document[] {
  const present = new Set(documents.map((document) => document.id));
  return documents.filter((document) => !(document.parentId && present.has(document.parentId)));
}
