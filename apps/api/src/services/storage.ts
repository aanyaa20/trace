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

/** Strips directory components and anything that could escape the upload root. */
export function safeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[^\w.\- ]+/g, '_').slice(0, 180);
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
