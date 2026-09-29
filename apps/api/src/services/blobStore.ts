import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deleteFiles, downloadFile, listFiles, uploadFiles } from '@huggingface/hub';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * Durable copies of uploaded files, for hosts whose disk does not survive a
 * restart (a Hugging Face Space is rebuilt from its image every time).
 *
 * UPLOAD_DIR stays the working copy: the ml service reads from it, previews
 * stream from it. With BLOB_STORE=hf every file written there is also
 * committed to a private Hugging Face dataset under the same relative path,
 * and a file missing locally is fetched back from it on first use. With
 * BLOB_STORE=local (the default, and every Compose setup) nothing here does
 * anything, because the uploads volume already persists.
 */
const enabled = (): boolean => env.BLOB_STORE === 'hf' && Boolean(env.HF_TOKEN && env.HF_STORAGE_REPO);

const repo = () => ({ type: 'dataset' as const, name: env.HF_STORAGE_REPO });

/** The path a local file is stored under in the dataset. */
export function remotePath(localPath: string): string | null {
  const relative = path.relative(env.UPLOAD_DIR, localPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

async function filesUnder(localPath: string): Promise<string[]> {
  const info = await stat(localPath).catch(() => null);
  if (!info) return [];
  if (info.isFile()) return [localPath];
  const entries = await readdir(localPath, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => filesUnder(path.join(localPath, entry.name))));
  return nested.flat();
}

/**
 * Commits these files, or every file under these directories, in one commit.
 * Never throws: a failed copy is logged, and the file is still served from
 * local disk until the next restart.
 */
export async function persist(localPaths: string[], title: string): Promise<void> {
  if (!enabled()) return;
  const files = (await Promise.all(localPaths.map(filesUnder))).flat();
  const entries = files
    .map((file) => ({ file, remote: remotePath(file) }))
    .filter((entry): entry is { file: string; remote: string } => entry.remote !== null);
  if (entries.length === 0) return;

  try {
    await uploadFiles({
      repo: repo(),
      accessToken: env.HF_TOKEN,
      commitTitle: title.slice(0, 200),
      files: entries.map((entry) => ({ path: entry.remote, content: pathToFileURL(entry.file) })),
      // Xet chunk-hashing holds a large file's chunks in memory; plain LFS
      // streams it. On a 512 MB instance the difference was ~100 MB.
      useXet: false,
    });
  } catch (cause) {
    logger.error({ err: String(cause), files: entries.length }, 'could not copy files to the storage dataset');
  }
}

/**
 * Makes sure a file is on local disk, fetching it from the dataset when a
 * restart has wiped it. Returns whether it is there now.
 */
export async function ensureLocal(localPath: string): Promise<boolean> {
  if (await stat(localPath).then(() => true, () => false)) return true;
  if (!enabled()) return false;
  const remote = remotePath(localPath);
  if (!remote) return false;

  try {
    const blob = await downloadFile({ repo: repo(), path: remote, accessToken: env.HF_TOKEN });
    if (!blob) return false;
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, Buffer.from(await blob.arrayBuffer()));
    return true;
  } catch (cause) {
    logger.warn({ err: String(cause), remote }, 'could not fetch a file from the storage dataset');
    return false;
  }
}

/** Removes these files, and everything under these directories, from the dataset. */
export async function forget(localPaths: string[], title: string): Promise<void> {
  if (!enabled()) return;
  const prefixes = localPaths.map(remotePath).filter((value): value is string => value !== null);
  if (prefixes.length === 0) return;

  try {
    const existing: string[] = [];
    for await (const entry of listFiles({ repo: repo(), accessToken: env.HF_TOKEN, recursive: true })) {
      if (entry.type === 'file' && prefixes.some((prefix) => entry.path === prefix || entry.path.startsWith(`${prefix}/`))) {
        existing.push(entry.path);
      }
    }
    if (existing.length > 0) {
      await deleteFiles({ repo: repo(), accessToken: env.HF_TOKEN, paths: existing, commitTitle: title.slice(0, 200) });
    }
  } catch (cause) {
    logger.warn({ err: String(cause) }, 'could not remove files from the storage dataset');
  }
}

/** Where extraction writes a document's rendered pages and keyframes. */
export function derivedDir(documentId: string): string {
  return path.join(env.UPLOAD_DIR, 'derived', documentId);
}
