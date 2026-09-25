import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { chunks, knowledgeBases } from '../db/schema.js';

export interface TargetKb {
  id: string;
  name: string;
  chunkCount: number;
}

/**
 * Resolves which knowledge base to evaluate. An empty one is never the one you
 * meant, and picking an arbitrary row would report a perfect zero that looks
 * like a retrieval regression rather than an empty index.
 */
export async function resolveKb(explicit?: string): Promise<TargetKb> {
  const candidates = await db
    .select({
      id: knowledgeBases.id,
      name: knowledgeBases.name,
      chunkCount: sql<number>`count(${chunks.id})::int`,
    })
    .from(knowledgeBases)
    .leftJoin(chunks, eq(chunks.kbId, knowledgeBases.id))
    .groupBy(knowledgeBases.id)
    .orderBy(desc(sql`count(${chunks.id})`), desc(knowledgeBases.createdAt));

  if (explicit) {
    const found = candidates.find(
      (candidate) => candidate.id === explicit || candidate.name === explicit,
    );
    if (!found) throw new Error(`knowledge base ${explicit} not found`);
    if (found.chunkCount === 0) throw new Error(`knowledge base ${found.name} has no indexed chunks`);
    return found;
  }

  const populated = candidates.find((candidate) => candidate.chunkCount > 0);
  if (!populated) {
    throw new Error(
      candidates.length === 0
        ? 'no knowledge bases exist yet; run pnpm seed first'
        : 'every knowledge base is empty; run pnpm seed or wait for ingestion to finish',
    );
  }
  return populated;
}

/**
 * Filenames actually present in the corpus, so a dataset that labels a document
 * which was never ingested fails loudly instead of scoring zero recall and
 * looking like the retriever's fault.
 */
export async function indexedFilenames(kbId: string): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ filename: sql<string>`d.filename` })
    .from(sql`documents d`)
    .where(sql`d.kb_id = ${kbId} and d.status = 'indexed'`);
  return new Set(rows.map((row) => row.filename));
}
