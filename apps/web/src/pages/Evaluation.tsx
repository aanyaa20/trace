import { useEffect, useMemo, useState } from 'react';
import type { EvalResult, EvalRun } from '@trace/contracts';
import { api } from '../lib/api.js';
import { useKb } from './KbLayout.js';
import { Chip, EmptyState, PageHeader, Segmented, SkeletonRows } from '../components/ui.js';

type QuestionFilter = 'all' | 'cited' | 'abstained' | 'imperfect';

/** Metric keys the harness writes, in the order the report reads them, with
 *  the ones where a lower number is better marked as such. */
const METRICS: Array<{ key: string; label: string; percent: boolean; lowerIsBetter?: boolean }> = [
  { key: 'questions', label: 'questions scored', percent: false },
  { key: 'abstentionAccuracy', label: 'abstention accuracy', percent: true },
  { key: 'citationPrecision', label: 'citation precision', percent: true },
  { key: 'citationsResolve', label: 'citations resolve', percent: true },
  { key: 'answerContains', label: 'answer contains', percent: true },
  { key: 'falseAnswerRate', label: 'false answer rate', percent: true, lowerIsBetter: true },
  { key: 'overAbstentionRate', label: 'over-abstention rate', percent: true, lowerIsBetter: true },
  { key: 'precisionAtK', label: 'precision@k', percent: true },
  { key: 'recallAtK', label: 'recall@k', percent: true },
  { key: 'hitAtK', label: 'hit@k', percent: true },
  { key: 'mrr', label: 'MRR', percent: false },
  { key: 'meanLatencyMs', label: 'mean latency', percent: false, lowerIsBetter: true },
  { key: 'meanIterations', label: 'mean iterations', percent: false },
];

/** A count is not a rate, and rendering 21 questions as "2100.0%" is the kind
 *  of thing that makes a reader stop trusting every other number on the page. */
const COUNTS = new Set(['questions']);

function show(key: string, value: number, percent: boolean): string {
  if (key === 'meanLatencyMs') return `${(value / 1000).toFixed(1)}s`;
  if (COUNTS.has(key)) return String(Math.round(value));
  // The harness stores rates as fractions; a value above 1 is already a
  // percentage and must not be multiplied a second time.
  if (percent) return `${(value <= 1 ? value * 100 : value).toFixed(1)}%`;
  return value.toFixed(value < 10 ? 2 : 1);
}

/**
 * The evaluation the project is judged on, read from the rows the harness
 * wrote rather than recomputed here. Two runs of the same dataset in different
 * modes sit side by side, because the comparison is the point: they share a
 * corpus, a synthesis prompt and a citation resolver, so the difference is the
 * retrieval strategy.
 */
export function Evaluation(): React.ReactElement {
  const { kb } = useKb();
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [results, setResults] = useState<EvalResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<QuestionFilter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoading(true);
    void api
      .evalRuns(kb.id)
      .then((list) => {
        if (!current) return;
        setRuns(list.runs);
        setSelected(list.runs[0]?.id ?? null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [kb.id]);

  useEffect(() => {
    if (!selected) {
      setResults([]);
      return;
    }
    let current = true;
    setExpanded(null);
    void api
      .evalResults(selected)
      .then((list) => current && setResults(list.results))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      current = false;
    };
  }, [selected]);

  const run = runs.find((entry) => entry.id === selected) ?? null;

  // The counterpart run: same dataset, other mode, nearest in time. Finding it
  // automatically is what turns two separate runs into one comparison.
  const counterpart = useMemo(() => {
    if (!run) return null;
    return (
      runs.find(
        (entry) => entry.id !== run.id && entry.dataset === run.dataset && entry.mode !== run.mode,
      ) ?? null
    );
  }, [run, runs]);

  const rows = useMemo(() => {
    if (!run?.metrics) return [];
    return METRICS.filter((metric) => metric.key in (run.metrics ?? {})).map((metric) => ({
      ...metric,
      primary: run.metrics?.[metric.key] ?? 0,
      other: counterpart?.metrics?.[metric.key] ?? null,
    }));
  }, [run, counterpart]);
  // The per-question list was 21 answers printed in full, which made the page
  // a scroll with no shape. Rows are one line each and open on demand, and a
  // filter gets to the interesting ones — which are the failures, not the
  // sixteen that behaved.
  const questions = useMemo(() => {
    return results.filter((result) => {
      if (filter === 'cited') return !result.abstained;
      if (filter === 'abstained') return result.abstained;
      if (filter === 'imperfect') {
        const precision = result.scores.citationPrecision;
        return precision !== undefined && precision < 1;
      }
      return true;
    });
  }, [results, filter]);

  const counts = useMemo(
    () => ({
      all: results.length,
      cited: results.filter((result) => !result.abstained).length,
      abstained: results.filter((result) => result.abstained).length,
      imperfect: results.filter((result) => {
        const precision = result.scores.citationPrecision;
        return precision !== undefined && precision < 1;
      }).length,
    }),
    [results],
  );

  return (
    <main className="min-h-0 flex-1 overflow-y-auto scroll-slim bg-paper">
      <div className="mx-auto max-w-[1280px] px-8 py-7">
        {/* The page is named for the question it answers rather than for the
            machinery that answers it. "Evaluation" tells a reader which screen
            they are on; this tells them what they are about to find out. */}
        <PageHeader
          title="Does the extra work pay for itself?"
          meta={`${runs.length} run${runs.length === 1 ? '' : 's'} recorded`}
          lede="The agentic loop against a single-pass baseline. Both modes share the synthesis prompt, the citation resolver and this corpus, so a difference below is the retrieval strategy and nothing else — including when the difference is unflattering."
        />

        {error && (
          <p className="mb-4 text-[13px]" style={{ color: 'var(--vermillion)' }}>
            {error}
          </p>
        )}

        {loading ? (
          <div className="panel">
            <SkeletonRows rows={4} />
          </div>
        ) : runs.length === 0 ? (
          <div className="panel">
            <EmptyState
              title="No evaluation has been run against this corpus yet"
              body="The retrieval stage costs no model requests and can be run as often as you like; the answer stage costs three to five per question per mode."
            />
            <p
              className="mono-meta border-t border-rule px-4 py-2.5"
              style={{ backgroundColor: 'var(--paper-sunk)' }}
            >
              docker compose exec api pnpm --filter @trace/api eval answer --mode both
            </p>
          </div>
        ) : (
          /* The metrics stay put while the questions scroll past them: the
             comparison is the reason to be on this page, and scrolling it out
             of view to read a question defeats the point. */
          <div className="grid gap-6" style={{ gridTemplateColumns: 'minmax(0, 380px) minmax(0, 1fr)' }}>
            <div className="self-start" style={{ position: 'sticky', top: 0 }}>
              <div className="flex flex-wrap gap-1.5 pb-3">
                {runs.map((entry) => {
                  const active = entry.id === selected;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setSelected(entry.id)}
                      className="rounded-md border px-2.5 py-1.5 text-left"
                      style={{
                        borderColor: active ? 'var(--vermillion)' : 'var(--rule)',
                        backgroundColor: active ? 'var(--surface-raised)' : 'transparent',
                        transition: 'border-color var(--dur) var(--ease-out)',
                      }}
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="text-[12px] font-medium text-ink">{entry.mode}</span>
                        {entry.finishedAt === null && <Chip tone="var(--ochre)">part</Chip>}
                      </span>
                      <span className="mono-meta block">
                        {entry.questionCount}q ·{' '}
                        {new Date(entry.startedAt).toLocaleDateString(undefined, {
                          day: 'numeric',
                          month: 'short',
                        })}
                      </span>
                    </button>
                  );
                })}
              </div>

              {run && (
                <>
                  <div className="panel">
                    <div className="panel-head">
                      <span className="eyebrow min-w-0 flex-1">metric</span>
                      <span className="eyebrow w-16 text-right">{run.mode}</span>
                      {counterpart && (
                        <span className="eyebrow w-16 text-right">{counterpart.mode}</span>
                      )}
                    </div>

                    {rows.map((row) => {
                      const better =
                        row.other === null || COUNTS.has(row.key)
                          ? null
                          : row.lowerIsBetter
                            ? row.primary < row.other
                            : row.primary > row.other;
                      return (
                        <div
                          key={row.key}
                          className="flex items-center gap-2 border-b border-rule px-3.5 py-1.5 last:border-b-0"
                        >
                          <span className="min-w-0 flex-1 truncate text-[12px] text-ink-muted">
                            {row.label}
                          </span>
                          <span
                            className="w-16 text-right font-mono text-[12px]"
                            style={{
                              color: better === true ? 'var(--moss)' : 'var(--ink)',
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {show(row.key, row.primary, row.percent)}
                          </span>
                          {counterpart && (
                            <span
                              className="w-16 text-right font-mono text-[12px]"
                              style={{
                                color: better === false ? 'var(--moss)' : 'var(--ink-muted)',
                                fontVariantNumeric: 'tabular-nums',
                              }}
                            >
                              {row.other === null ? '—' : show(row.key, row.other, row.percent)}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {run.config && Object.keys(run.config).length > 0 && (
                    <details className="mt-2">
                      <summary className="eyebrow cursor-pointer select-none">
                        thresholds this run used
                      </summary>
                      <ul className="mt-2 space-y-0.5">
                        {Object.entries(run.config).map(([key, value]) => (
                          <li key={key} className="mono-meta flex gap-2">
                            <span className="min-w-0 flex-1 truncate">{key}</span>
                            <span style={{ color: 'var(--ink-muted)' }}>{value}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              )}
            </div>

            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 pb-3">
                <Segmented
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: 'all' as const, label: `all ${counts.all}` },
                    { value: 'cited' as const, label: `cited ${counts.cited}` },
                    { value: 'abstained' as const, label: `abstained ${counts.abstained}` },
                    { value: 'imperfect' as const, label: `imperfect ${counts.imperfect}` },
                  ]}
                />
                <span className="mono-meta ml-auto">click a question to read its answer</span>
              </div>

              <div className="panel">
                {questions.length === 0 ? (
                  <EmptyState title="Nothing in this run matches that filter" />
                ) : (
                  questions.map((result) => {
                    const precision = result.scores.citationPrecision;
                    const open = expanded === result.id;
                    return (
                      <div key={result.id} className="border-b border-rule last:border-b-0">
                        <button
                          type="button"
                          onClick={() => setExpanded(open ? null : result.id)}
                          className="flex w-full items-center gap-3 px-3.5 py-2 text-left hover:bg-surface-raised"
                          style={{ transition: 'background-color var(--dur) var(--ease-out)' }}
                        >
                          <span
                            aria-hidden
                            className="mono-meta w-3 shrink-0"
                            style={{ color: 'var(--ink-faint)' }}
                          >
                            {open ? '▾' : '▸'}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                            {result.question}
                          </span>

                          {result.abstained ? (
                            <Chip>abstained</Chip>
                          ) : (
                            <Chip tone="var(--moss)">{result.citations.length} cited</Chip>
                          )}

                          <span
                            className="mono-meta w-10 shrink-0 text-right"
                            style={{
                              color:
                                precision === undefined
                                  ? undefined
                                  : precision >= 0.99
                                    ? 'var(--moss)'
                                    : precision === 0
                                      ? 'var(--vermillion)'
                                      : 'var(--ochre)',
                            }}
                          >
                            {precision === undefined ? '' : precision.toFixed(2)}
                          </span>
                          <span className="mono-meta w-12 shrink-0 text-right">
                            {result.latencyMs ? `${(result.latencyMs / 1000).toFixed(1)}s` : ''}
                          </span>
                        </button>

                        {open && (
                          <div
                            className="animate-lift px-3.5 pb-3 pl-9"
                            style={{ backgroundColor: 'var(--paper-sunk)' }}
                          >
                            <p className="measure pt-1 text-[13px] leading-relaxed text-ink-muted">
                              {result.answer}
                            </p>
                            {result.citations.length > 0 && (
                              <ul className="mt-2 space-y-0.5">
                                {result.citations.map((citation) => (
                                  <li key={citation.chunkId} className="mono-meta">
                                    [{citation.marker}] {citation.filename}
                                    {citation.page !== null ? ` · p.${citation.page}` : ''}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
