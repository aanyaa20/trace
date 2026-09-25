import path from 'node:path';
import type { RetrievalMode } from '@trace/contracts';
import { closeDatabase } from '../db/client.js';
import { closeRedis } from '../queue/connection.js';
import { env } from '../env.js';
import { toError } from '../errors.js';
import { runAnswers, type AnswerReport } from './answer.js';
import { indexedFilenames, resolveKb } from './corpus.js';
import { loadDataset } from './dataset.js';
import { printAnswers, printRetrieval, writeMarkdown } from './report.js';
import { runRetrieval, type RetrievalReport } from './retrieval.js';

const DEFAULT_DATASET = '/app/eval/datasets/sample-corpus.jsonl';
const DEFAULT_REPORT_DIR = '/app/eval/reports';

const USAGE = `usage:
  pnpm eval retrieval [--dataset <path>] [--kb <uuid|name>] [--k 10]
  pnpm eval answer    [--dataset <path>] [--kb <uuid|name>] [--mode agentic|naive|both]
                      [--limit <n>] [--resume <runId>] [--notes "..."]
  pnpm eval all       [--dataset <path>] [--kb <uuid|name>] [--k 10] [--limit <n>]

retrieval costs no LLM quota and can be run as often as you like.
answer costs three to five requests per question per mode; it writes each
result as it goes and stops cleanly when the daily quota is gone.
`;

interface Args {
  stage: 'retrieval' | 'answer' | 'all';
  dataset: string;
  kb?: string;
  k: number;
  mode: 'agentic' | 'naive' | 'both';
  limit?: number;
  resume?: string;
  notes?: string;
  out?: string;
}

function parseArgs(argv: string[]): Args | null {
  const stage = argv[0];
  if (stage !== 'retrieval' && stage !== 'answer' && stage !== 'all') return null;

  const args: Args = { stage, dataset: DEFAULT_DATASET, k: env.RETRIEVAL_TOP_K, mode: 'both' };

  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--dataset':
        args.dataset = value ?? args.dataset;
        i += 1;
        break;
      case '--kb':
        args.kb = value;
        i += 1;
        break;
      case '--k':
        args.k = Number(value ?? args.k);
        i += 1;
        break;
      case '--mode':
        if (value !== 'agentic' && value !== 'naive' && value !== 'both') return null;
        args.mode = value;
        i += 1;
        break;
      case '--limit':
        args.limit = Number(value);
        i += 1;
        break;
      case '--resume':
        args.resume = value;
        i += 1;
        break;
      case '--notes':
        args.notes = value;
        i += 1;
        break;
      case '--out':
        args.out = value;
        i += 1;
        break;
      default:
        return null;
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stdout.write(USAGE);
    process.exitCode = 1;
    return;
  }

  const kb = await resolveKb(args.kb);
  const all = await loadDataset(args.dataset);

  // A label naming a document that was never ingested would score as a
  // retrieval failure and send you debugging the retriever. Fail on it instead.
  const present = await indexedFilenames(kb.id);
  const missing = [
    ...new Set(all.flatMap((item) => item.relevantDocuments).filter((name) => !present.has(name))),
  ];
  if (missing.length > 0) {
    throw new Error(
      `dataset labels documents that are not indexed in ${kb.name}: ${missing.join(', ')}`,
    );
  }

  const items = args.limit ? all.slice(0, args.limit) : all;
  process.stdout.write(
    `knowledge base ${kb.name} (${kb.chunkCount} chunks) · ${items.length} of ${all.length} questions\n`,
  );

  let retrieval: RetrievalReport | null = null;
  const answers: AnswerReport[] = [];

  if (args.stage === 'retrieval' || args.stage === 'all') {
    retrieval = await runRetrieval(kb.id, items, args.k);
    printRetrieval(retrieval, kb.name);
  }

  if (args.stage === 'answer' || args.stage === 'all') {
    const modes: RetrievalMode[] = args.mode === 'both' ? ['agentic', 'naive'] : [args.mode];
    for (const mode of modes) {
      // Sequential across modes as well as questions: the free tier meters per
      // minute, and two loops at once spend the budget racing each other.
      const report = await runAnswers(kb.id, path.basename(args.dataset), items, mode, {
        ...(args.resume ? { resumeRunId: args.resume } : {}),
        ...(args.notes ? { notes: args.notes } : {}),
      });
      printAnswers(report);
      answers.push(report);
      if (report.partial) break;
    }
  }

  const destination =
    args.out ??
    path.join(DEFAULT_REPORT_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  const written = await writeMarkdown(destination, kb.name, path.basename(args.dataset), retrieval, answers);
  process.stdout.write(`report written to ${written}\n`);
}

main()
  .catch((cause: unknown) => {
    process.stderr.write(`eval failed: ${toError(cause).message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
    await closeRedis();
  });
