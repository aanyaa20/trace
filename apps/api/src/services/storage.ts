import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { Modality } from '@trace/contracts';
import { env } from '../env.js';
import { unsupportedMedia } from '../errors.js';

const MIME_TO_MODALITY: ReadonlyArray<readonly [RegExp, Modality]> = [
  [/^application\/pdf$/, 'pdf'],
  [/^image\//, 'image'],
  [/^audio\//, 'audio'],
  [/^video\//, 'video'],
  [/^text\//, 'text'],
  [/^application\/(json|xml|x-ndjson)$/, 'text'],
  [/^application\/vnd\.openxmlformats-officedocument\..*$/, 'text'],
  [/^application\/msword$/, 'text'],
];

export function modalityForMime(mime: string): Modality {
  const normalised = mime.split(';')[0]!.trim().toLowerCase();
  const match = MIME_TO_MODALITY.find(([pattern]) => pattern.test(normalised));
  if (!match) throw unsupportedMedia(normalised || 'unknown');
  return match[1];
}

/** Most filesystems cap a name at 255 bytes; the stored name also carries a
 *  37-byte document-id prefix, so the part kept from the user stops well short. */
const MAX_FILENAME_BYTES = 200;

/** Cuts to a byte budget without splitting a character in half. */
function truncateBytes(value: string, max: number): string {
  let bytes = 0;
  let out = '';
  for (const char of value) {
    bytes += Buffer.byteLength(char);
    if (bytes > max) break;
    out += char;
  }
  return out;
}

/** Strips directory components and anything that could escape the upload root. */
export function safeFilename(filename: string): string {
  // Letters, marks and digits in any script survive — `\w` alone is ASCII-only
  // in JavaScript, which turned every Hindi or Chinese filename into a row of
  // underscores. Marks (\p{M}) matter for Devanagari: the vowel signs are
  // combining marks, and dropping them breaks every word.
  const cleaned = path
    .basename(filename)
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}_.\- ]+/gu, '_');
  const base = truncateBytes(cleaned, MAX_FILENAME_BYTES);
  return base.length > 0 ? base : 'upload';
}

export function storagePathFor(kbId: string, documentId: string, filename: string): string {
  return path.join(env.UPLOAD_DIR, kbId, `${documentId}-${safeFilename(filename)}`);
}

/**
 * Streams a multipart part to disk. The file never exists as a Buffer, which
 * is what keeps a 500 MB video from becoming 500 MB of heap.
 */
export async function persistStream(source: Readable, destination: string): Promise<number> {
  await mkdir(path.dirname(destination), { recursive: true });
  await pipeline(source, createWriteStream(destination));
  const { size } = await stat(destination);
  return size;
}

export async function persistBuffer(body: Buffer, destination: string): Promise<number> {
  await mkdir(path.dirname(destination), { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(destination, body);
  return body.byteLength;
}

export async function removeStoredFile(storagePath: string): Promise<void> {
  await rm(storagePath, { force: true });
}

/** Every file stored for one knowledge base: its directory on the volume. */
export async function removeKbFiles(kbId: string): Promise<void> {
  await rm(path.join(env.UPLOAD_DIR, kbId), { recursive: true, force: true });
}
