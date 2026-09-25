import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { modalitySchema } from '@trace/contracts';

/**
 * One labelled question.
 *
 * Relevance is labelled by filename rather than chunk id. Chunk ids are
 * regenerated on every re-ingest, so a dataset keyed to them would silently
 * score zero the first time the corpus is rebuilt and look like a retrieval
 * regression. Filenames survive that, and page and timestamp narrow it where
 * the distinction matters.
 */
export const evalItemSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  /** Documents that actually contain the answer. Empty when unanswerable. */
  relevantDocuments: z.array(z.string()).default([]),
  /** Optional narrowing, for questions where the page or moment is the point. */
  relevantPages: z.array(z.number().int().positive()).default([]),
  /** Substrings the answer should contain, matched case-insensitively. */
  expectAnswerContains: z.array(z.string()).default([]),
  /**
   * True when the corpus cannot support an answer. The correct behaviour is
   * abstention, and answering anyway is the failure this system exists to
   * avoid, so these questions carry the most weight in the report.
   */
  unanswerable: z.boolean().default(false),
  modality: modalitySchema.optional(),
  note: z.string().optional(),
});
export type EvalItem = z.infer<typeof evalItemSchema>;

/**
 * JSONL, not JSON. A dataset is appended to far more often than it is
 * rewritten, and a one-line-per-question file gives a readable diff when a
 * label changes.
 */
export async function loadDataset(path: string): Promise<EvalItem[]> {
  const raw = await readFile(path, 'utf8');
  const items: EvalItem[] = [];
  const seen = new Set<string>();

  raw.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('//')) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`${path}:${index + 1} is not valid JSON`);
    }

    const result = evalItemSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `${path}:${index + 1} ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      );
    }

    // A duplicate id makes resume ambiguous and silently double-counts.
    if (seen.has(result.data.id)) throw new Error(`${path}:${index + 1} duplicate id ${result.data.id}`);
    seen.add(result.data.id);

    // A labelled-relevant document on an unanswerable question is a
    // contradiction, and it would score as both a hit and a required abstention.
    if (result.data.unanswerable && result.data.relevantDocuments.length > 0) {
      throw new Error(`${path}:${index + 1} ${result.data.id} is unanswerable but labels relevant documents`);
    }
    if (!result.data.unanswerable && result.data.relevantDocuments.length === 0) {
      throw new Error(`${path}:${index + 1} ${result.data.id} is answerable but labels no relevant documents`);
    }

    items.push(result.data);
  });

  if (items.length === 0) throw new Error(`${path} contains no questions`);
  return items;
}
