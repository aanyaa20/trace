import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AnswerReport } from './answer.js';
import type { RetrievalReport } from './retrieval.js';

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function ms(value: number): string {
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}

export function printRetrieval(report: RetrievalReport, kbName: string): void {
  const out = process.stdout;
  out.write(`\nretrieval · ${kbName} · k=${report.k} · ${report.outcomes.length} questions\n`);
  out.write(`${'-'.repeat(72)}\n`);

  for (const outcome of report.outcomes) {
    const flag = outcome.scores.hit === 1 ? ' ' : '!';
    out.write(
      `${flag} ${outcome.item.id.padEnd(8)} p=${outcome.scores.precision.toFixed(2)}  r=${outcome.scores.recall.toFixed(2)}  rr=${outcome.scores.reciprocalRank.toFixed(2)}  ${ms(outcome.latencyMs).padStart(6)}  ${outcome.item.question.slice(0, 40)}\n`,
    );
  }

  out.write(`${'-'.repeat(72)}\n`);
  out.write(
    `precision@${report.k} ${pct(report.metrics[`precision@${report.k}`] ?? 0)}   recall@${report.k} ${pct(report.metrics[`recall@${report.k}`] ?? 0)}   hit@${report.k} ${pct(report.metrics[`hit@${report.k}`] ?? 0)}   mrr ${(report.metrics.mrr ?? 0).toFixed(3)}\n`,
  );
  // A question that retrieved nothing relevant is the one to look at first:
  // no loop can recover from evidence that was never fetched.
  const missed = report.outcomes.filter((outcome) => outcome.scores.hit === 0);
  if (missed.length > 0) {
    out.write(`\n${missed.length} question(s) retrieved nothing relevant:\n`);
    for (const outcome of missed) out.write(`  ${outcome.item.id}  ${outcome.item.question}\n`);
  }
  out.write('\n');
}

export function printAnswers(report: AnswerReport): void {
  const out = process.stdout;
  out.write(`\n${report.mode} · run ${report.runId} · ${report.outcomes.length} questions\n`);
  out.write(`${'-'.repeat(72)}\n`);

  for (const outcome of report.outcomes) {
    const verdict = outcome.scores.abstentionCorrect === 1 ? ' ' : '!';
    const behaviour = outcome.abstained ? 'abstained' : `${outcome.citations.length} cited`;
    out.write(
      `${verdict} ${outcome.item.id.padEnd(8)} ${behaviour.padEnd(11)} cp=${outcome.scores.citationPrecision.toFixed(2)}  ${ms(outcome.latencyMs).padStart(6)}  ${outcome.item.question.slice(0, 36)}\n`,
    );
  }

  out.write(`${'-'.repeat(72)}\n`);
  out.write(
    `abstention ${pct(report.metrics.abstentionAccuracy ?? 0)}   citation precision ${pct(report.metrics.citationPrecision ?? 0)}   citations resolve ${pct(report.metrics.citationsResolve ?? 0)}\n`,
  );
  out.write(
    `false answers ${pct(report.metrics.falseAnswerRate ?? 0)}   over-abstention ${pct(report.metrics.overAbstentionRate ?? 0)}   mean ${ms(report.metrics.meanLatencyMs ?? 0)}\n`,
  );

  if (report.partial) {
    out.write(
      `\nSTOPPED on an exhausted daily quota with ${report.remaining.length} question(s) left.\n` +
        `Resume tomorrow with:  pnpm eval answer --resume ${report.runId} --mode ${report.mode}\n`,
    );
  }
  out.write('\n');
}

/**
 * Writes the comparison as markdown. The evaluation chapter needs a table it
 * can quote, and a number that only ever existed in a terminal is a number
 * nobody can check.
 */
export async function writeMarkdown(
  destination: string,
  kbName: string,
  dataset: string,
  retrieval: RetrievalReport | null,
  answers: AnswerReport[],
): Promise<string> {
  const lines: string[] = [
    `# Evaluation · ${kbName}`,
    '',
    `Dataset \`${dataset}\`, generated ${new Date().toISOString()}.`,
    '',
  ];

  if (retrieval) {
    lines.push(
      '## Retrieval',
      '',
      `No LLM requests. ${retrieval.outcomes.length} answerable questions, k=${retrieval.k}.`,
      '',
      '| metric | value |',
      '|---|---|',
      `| precision@${retrieval.k} | ${pct(retrieval.metrics[`precision@${retrieval.k}`] ?? 0)} |`,
      `| recall@${retrieval.k} | ${pct(retrieval.metrics[`recall@${retrieval.k}`] ?? 0)} |`,
      `| hit@${retrieval.k} | ${pct(retrieval.metrics[`hit@${retrieval.k}`] ?? 0)} |`,
      `| MRR | ${(retrieval.metrics.mrr ?? 0).toFixed(3)} |`,
      `| median latency | ${ms(retrieval.metrics.medianLatencyMs ?? 0)} |`,
      '',
    );
  }

  if (answers.length > 0) {
    lines.push(
      '## Answers',
      '',
      'Both modes share the synthesis prompt and the citation resolver, so the',
      'difference below is the retrieval strategy and nothing else.',
      '',
      `| metric | ${answers.map((report) => report.mode).join(' | ')} |`,
      `|---|${answers.map(() => '---').join('|')}|`,
      `| questions | ${answers.map((r) => r.metrics.questions ?? 0).join(' | ')} |`,
      `| abstention accuracy | ${answers.map((r) => pct(r.metrics.abstentionAccuracy ?? 0)).join(' | ')} |`,
      `| citation precision | ${answers.map((r) => pct(r.metrics.citationPrecision ?? 0)).join(' | ')} |`,
      `| citations resolve | ${answers.map((r) => pct(r.metrics.citationsResolve ?? 0)).join(' | ')} |`,
      `| answer contains | ${answers.map((r) => pct(r.metrics.answerContains ?? 0)).join(' | ')} |`,
      `| false answer rate | ${answers.map((r) => pct(r.metrics.falseAnswerRate ?? 0)).join(' | ')} |`,
      `| over-abstention rate | ${answers.map((r) => pct(r.metrics.overAbstentionRate ?? 0)).join(' | ')} |`,
      `| mean latency | ${answers.map((r) => ms(r.metrics.meanLatencyMs ?? 0)).join(' | ')} |`,
      `| mean iterations | ${answers.map((r) => (r.metrics.meanIterations ?? 0).toFixed(2)).join(' | ')} |`,
      '',
      `Runs: ${answers.map((report) => `\`${report.runId}\` (${report.mode}${report.partial ? ', partial' : ''})`).join(', ')}.`,
      '',
    );

    for (const report of answers) {
      lines.push(`### ${report.mode}`, '', '| id | behaviour | citation precision | question |', '|---|---|---|---|');
      for (const outcome of report.outcomes) {
        lines.push(
          `| ${outcome.item.id} | ${outcome.abstained ? 'abstained' : `${outcome.citations.length} cited`} | ${outcome.scores.citationPrecision.toFixed(2)} | ${outcome.item.question.replace(/\|/g, '\\|')} |`,
        );
      }
      lines.push('');
    }
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${lines.join('\n')}\n`, 'utf8');
  return destination;
}
