import { desc, eq, sql } from 'drizzle-orm';
import { closeDatabase, db } from '../db/client.js';
import { chunks, knowledgeBases } from '../db/schema.js';
import { closeRedis } from '../queue/connection.js';
import { hybridSearch } from '../retrieval/hybrid.js';
import { toError } from '../errors.js';

/**
 * Inspection tool for the retrieval layer on its own, with no agent and no
 * LLM in the way. When an answer is wrong this is what says whether the
 * evidence was missing or merely ignored.
 *
 *   pnpm retrieve "some query" [--kb <uuid>] [--limit 10]
 */
function parseArgs(argv: string[]): { query: string; kbId?: string; limit: number } {
  const positional: string[] = [];
  let kbId: string | undefined;
  let limit = 10;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--kb') {
      kbId = argv[++i];
    } else if (arg === '--limit') {
      limit = Number(argv[++i] ?? 10);
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  return { query: positional.join(' ').trim(), ...(kbId ? { kbId } : {}), limit };
}

function formatLocator(chunk: {
  page: number | null;
  tsStart: number | null;
  tsEnd: number | null;
  imagePath: string | null;
}): string {
  if (chunk.page !== null) return `page ${chunk.page}`;
  if (chunk.tsStart !== null) {
    const stamp = (seconds: number): string =>
      `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    return `${stamp(chunk.tsStart)}-${stamp(chunk.tsEnd ?? chunk.tsStart)}`;
  }
  if (chunk.imagePath) return 'image';
  return 'whole document';
}

async function main(): Promise<void> {
  const { query, kbId, limit } = parseArgs(process.argv.slice(2));
  if (!query) {
    process.stdout.write('usage: pnpm retrieve "your query" [--kb <uuid>] [--limit 10]\n');
    process.exitCode = 1;
    return;
  }

  let targetKb = kbId;
  if (!targetKb) {
    // An empty knowledge base is never the one you meant, and picking an
    // arbitrary row silently returns nothing and looks like a broken index.
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

    const populated = candidates.find((candidate) => candidate.chunkCount > 0);
    if (!populated) {
      process.stdout.write(
        candidates.length === 0
          ? 'no knowledge bases exist yet; run pnpm seed first\n'
          : 'every knowledge base is empty; run pnpm seed or wait for ingestion to finish\n',
      );
      process.exitCode = 1;
      return;
    }

    targetKb = populated.id;
    process.stdout.write(
      `using knowledge base ${populated.name} (${targetKb}, ${populated.chunkCount} chunks)\n`,
    );
  } else {
    const [found] = await db.select().from(knowledgeBases).where(eq(knowledgeBases.id, targetKb));
    if (!found) {
      process.stdout.write(`knowledge base ${targetKb} not found\n`);
      process.exitCode = 1;
      return;
    }
  }

  const started = Date.now();
  const result = await hybridSearch({ kbId: targetKb, query, limit });

  process.stdout.write(
    `\nquery: ${query}\n${result.chunks.length} of ${result.candidateCount} fused candidates in ${Date.now() - started}ms\n\n`,
  );

  result.chunks.forEach((chunk, index) => {
    const preview = chunk.text.replace(/\s+/g, ' ').slice(0, 160);
    process.stdout.write(
      `${String(index + 1).padStart(2)}. rrf=${chunk.score.toFixed(5)}  ${chunk.modality}/${chunk.source}  ${chunk.filename} :: ${formatLocator(chunk)}\n    ${preview}${chunk.text.length > 160 ? '...' : ''}\n\n`,
    );
  });

  if (result.chunks.length === 0) {
    process.stdout.write('no chunks matched. is the document indexed?\n');
  }
}

main()
  .catch((cause: unknown) => {
    process.stderr.write(`retrieve failed: ${toError(cause).message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
    await closeRedis();
  });
