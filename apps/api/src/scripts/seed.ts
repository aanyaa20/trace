import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import argon2 from 'argon2';
import { closeDatabase, db } from '../db/client.js';
import { documents, knowledgeBases, users } from '../db/schema.js';
import { env } from '../env.js';
import { toError } from '../errors.js';
import { closeRedis } from '../queue/connection.js';
import { enqueueIngestion } from '../queue/queues.js';
import { modalityForMime, safeFilename, storagePathFor } from '../services/storage.js';

const CORPUS_DIR = process.env.SAMPLE_CORPUS_DIR ?? '/app/sample-corpus';
const SEED_EMAIL = process.env.SEED_EMAIL ?? 'demo@trace.local';
const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'trace-demo-password';
const KB_NAME = 'Sample corpus';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

async function ensureUser(): Promise<string> {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, SEED_EMAIL));
  if (existing) return existing.id;

  const [created] = await db
    .insert(users)
    .values({ email: SEED_EMAIL, passwordHash: await argon2.hash(SEED_PASSWORD) })
    .returning({ id: users.id });
  if (!created) throw new Error('could not create the seed user');
  return created.id;
}

async function ensureKnowledgeBase(userId: string): Promise<string> {
  const [existing] = await db
    .select({ id: knowledgeBases.id })
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.userId, userId), eq(knowledgeBases.name, KB_NAME)));
  if (existing) return existing.id;

  const [created] = await db
    .insert(knowledgeBases)
    .values({
      userId,
      name: KB_NAME,
      description: 'One document per modality, ingested by pnpm seed',
    })
    .returning({ id: knowledgeBases.id });
  if (!created) throw new Error('could not create the sample knowledge base');
  return created.id;
}

async function main(): Promise<void> {
  const entries = await readdir(CORPUS_DIR).catch(() => {
    throw new Error(`sample corpus not found at ${CORPUS_DIR}`);
  });

  const files = entries.filter((name) => MIME_BY_EXTENSION[path.extname(name).toLowerCase()]);
  if (files.length === 0) throw new Error(`no ingestible files in ${CORPUS_DIR}`);

  const userId = await ensureUser();
  const kbId = await ensureKnowledgeBase(userId);
  process.stdout.write(`seed user ${SEED_EMAIL}\nknowledge base ${kbId}\n\n`);

  await mkdir(env.UPLOAD_DIR, { recursive: true });

  for (const name of files) {
    const [already] = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.kbId, kbId), eq(documents.filename, name)));

    if (already) {
      process.stdout.write(`skip    ${name} (already present)\n`);
      continue;
    }

    const source = path.join(CORPUS_DIR, name);
    const documentId = randomUUID();
    const storagePath = storagePathFor(kbId, documentId, safeFilename(name));
    const mime = MIME_BY_EXTENSION[path.extname(name).toLowerCase()]!;

    await mkdir(path.dirname(storagePath), { recursive: true });
    await copyFile(source, storagePath);
    const { size } = await stat(storagePath);

    await db.insert(documents).values({
      id: documentId,
      kbId,
      filename: name,
      storagePath,
      mime,
      sizeBytes: size,
      modality: modalityForMime(mime),
      status: 'queued',
    });

    await enqueueIngestion({ documentId, kbId });
    process.stdout.write(`queued  ${name.padEnd(22)} ${modalityForMime(mime).padEnd(6)} ${size.toLocaleString()} bytes\n`);
  }

  process.stdout.write(
    `\nqueued for ingestion. watch progress with:\n  docker compose logs -f worker\n\nthen query it:\n  pnpm retrieve "how does chunking preserve page numbers" --kb ${kbId}\n`,
  );
}

main()
  .catch((cause: unknown) => {
    process.stderr.write(`seed failed: ${toError(cause).message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
    await closeRedis();
  });
