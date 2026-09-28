import { useState } from 'react';
import type { AgentEvent, AgentStage } from '@trace/contracts';

const STAGE_LABEL: Record<AgentStage, string> = {
  converse: 'converse',
  analyse: 'analyse',
  retrieve: 'retrieve',
  rerank: 'rerank',
  grade: 'grade',
  sufficiency: 'sufficiency',
  web_search: 'web search',
  visual_check: 'visual check',
  synthesise: 'synthesise',
  citations: 'citations',
};

const DECISION_COLOR: Record<string, string> = {
  answer: 'var(--moss)',
  retry: 'var(--ochre)',
  web_fallback: 'var(--ink-muted)',
  abstain: 'var(--vermillion)',
};

function duration(ms: number | null): string {
  if (ms === null) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Completed events supersede the 'started' event for the same stage, so the
 *  list shows one row per stage rather than doubling as each one finishes. */
function collapse(events: AgentEvent[]): AgentEvent[] {
  const rows: AgentEvent[] = [];
  for (const event of events) {
    const index = rows.findIndex(
      (row) =>
        row.stage === event.stage &&
        row.iteration === event.iteration &&
        row.startedAt === event.startedAt,
    );
    if (index >= 0) rows[index] = event;
    else rows.push(event);
  }
  return rows;
}

/** "paper.pdf p.3" / "lecture.mp4 12:43" — where a candidate sits. */
function where(item: { filename: string; page: number | null; tsStart: number | null }): string {
  if (item.page !== null) return `${item.filename} p.${item.page}`;
  if (item.tsStart !== null) {
    const m = Math.floor(item.tsStart / 60);
    return `${item.filename} ${m}:${String(Math.floor(item.tsStart % 60)).padStart(2, '0')}`;
  }
  return item.filename;
}

function StagePayload({ event }: { event: AgentEvent }): React.ReactElement | null {
  const payload = event.payload;
  if (!payload) return null;

  switch (payload.stage) {
    case 'analyse':
      return payload.analysis ? (
        <div className="space-y-1.5">
          <p className="text-ink">{payload.analysis.intent}</p>
          <ul className="space-y-0.5">
            {payload.analysis.rewrites.map((rewrite) => (
              <li key={rewrite} className="text-ink-muted">
                rewrote as “{rewrite}”
              </li>
            ))}
          </ul>
          {payload.analysis.modalityHints.length > 0 && (
            <p className="mono-meta">looking in {payload.analysis.modalityHints.join(', ')}</p>
          )}
        </div>
      ) : null;

    case 'retrieve':
      return (
        <div className="space-y-1.5">
          <ul className="space-y-0.5">
            {payload.queries.map((query) => (
              <li key={query} className="text-ink-muted">
                searched “{query}”
              </li>
            ))}
          </ul>
          <p className="mono-meta">
            {payload.candidateCount} candidates from dense + BM25, fused to {payload.chunks.length}
            {payload.evidenceType && payload.evidenceType !== 'text' && ` · also searched ${payload.evidenceType} regions`}
          </p>
          <ul className="space-y-0.5">
            {payload.chunks.map((chunk) => (
              <li key={chunk.chunkId} className="flex gap-2">
                <span className="mono-meta w-14 shrink-0 tabular-nums">{chunk.score.toFixed(4)}</span>
                <span className="truncate text-ink-muted">{where(chunk)}</span>
              </li>
            ))}
          </ul>
        </div>
      );

    case 'rerank':
      return (
        <div className="space-y-1.5">
          <p className="mono-meta">
            {payload.model} · kept {payload.keptCount} of {payload.candidates.length}
          </p>
          <ul className="space-y-0.5">
            {payload.candidates.map((candidate) => (
              <li key={candidate.chunkId} className="flex gap-2">
                <span
                  className="mono-meta w-8 shrink-0"
                  style={{ color: candidate.kept ? 'var(--moss)' : 'var(--ink-faint)' }}
                >
                  {candidate.kept ? 'keep' : 'drop'}
                </span>
                <span className="mono-meta w-10 shrink-0 tabular-nums">
                  {candidate.rerankScore.toFixed(2)}
                </span>
                <span className="truncate text-ink-muted">{where(candidate)}</span>
              </li>
            ))}
          </ul>
        </div>
      );

    case 'grade':
      return (
        <ul className="space-y-1">
          {payload.grades.map((grade) => (
            <li key={grade.chunkId} className="flex gap-2">
              <span
                className="mono-meta w-8 shrink-0"
                style={{ color: grade.relevant ? 'var(--moss)' : 'var(--ink-faint)' }}
              >
                {grade.relevant ? 'keep' : 'drop'}
              </span>
              <span className="mono-meta w-8 shrink-0">{grade.score.toFixed(2)}</span>
              {/* The grader's own sentence, rendered verbatim. */}
              <span className="text-ink-muted">{grade.reason}</span>
            </li>
          ))}
        </ul>
      );

    case 'sufficiency':
      return (
        <div className="space-y-1">
          <p
            className="mono-meta uppercase tracking-[0.14em]"
            style={{ color: DECISION_COLOR[payload.decision] ?? 'var(--ink)' }}
          >
            {payload.decision.replace('_', ' ')}
          </p>
          <p className="text-ink-muted">{payload.rationale}</p>
          <p className="mono-meta">
            threshold {payload.thresholds.minRelevantChunks} chunks ≥ {payload.thresholds.minScore}
          </p>
          {payload.confidence && (
            <p className="mono-meta">
              confidence {payload.confidence.retrievalConfidence.toFixed(2)} · top{' '}
              {payload.confidence.topScore.toFixed(2)} · {payload.confidence.candidateCount} retrieved →{' '}
              {payload.confidence.rerankedCount} reranked → {payload.confidence.evidenceCount} evidence ·
              judged by {payload.confidence.basis}
            </p>
          )}
        </div>
      );

    case 'web_search':
      return (
        <div className="space-y-1">
          <p className="text-ink-muted">searched “{payload.query}”</p>
          {payload.results.map((result) => (
            <p key={result.chunkId} className="mono-meta" style={{ color: 'var(--ochre)' }}>
              external · {result.filename}
            </p>
          ))}
        </div>
      );

    case 'visual_check':
      return (
        <div className="space-y-1">
          <p className="text-ink-muted">
            {payload.regionCandidates} chart, table or picture regions searched on their own
            {payload.visionAvailable ? '' : ' · no vision model was reachable'}
          </p>
          {payload.readings.map((reading) => (
            <p key={reading.chunkId} className="flex gap-2">
              <span
                className="mono-meta w-12 shrink-0"
                style={{ color: reading.found ? 'var(--moss)' : 'var(--ink-faint)' }}
              >
                {reading.found ? 'found' : 'not shown'}
              </span>
              <span className="text-ink-muted">
                {reading.regionType && reading.regionType !== 'text'
                  ? `${reading.regionType}${reading.regionTitle ? ` “${reading.regionTitle}”` : ''} in `
                  : ''}
                {reading.filename}
                {reading.answer ? ` — ${reading.answer}` : ''}
              </span>
            </p>
          ))}
        </div>
      );

    case 'synthesise':
      return (
        <div className="space-y-1.5">
          <p className="text-ink-muted">
            {payload.abstained ? 'abstained' : `${payload.characters} characters`}
          </p>
          {payload.question && <p className="text-ink-muted">answered “{payload.question}”</p>}
          {payload.sources && payload.sources.length > 0 && (
            <ul className="space-y-1">
              {payload.sources.map((source) => (
                <li key={source.chunkId}>
                  <span className="flex gap-2">
                    <span className="mono-meta w-6 shrink-0">[{source.n}]</span>
                    <span className="mono-meta w-10 shrink-0 tabular-nums">{source.score.toFixed(2)}</span>
                    <span className="truncate text-ink-muted">
                      {source.external ? `external · ${source.filename}` : where(source)}
                    </span>
                  </span>
                  {/* Present only when the server runs with AGENT_DEBUG. */}
                  {source.text && (
                    <span className="mono-meta mt-0.5 block whitespace-pre-wrap pl-8">{source.text}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      );

    case 'citations':
      return (
        <div className="space-y-1">
          <p style={{ color: 'var(--moss)' }}>{payload.citations.length} verified</p>
          {payload.rejectedMarkers.length > 0 && (
            <p style={{ color: 'var(--vermillion)' }}>
              dropped unverifiable markers {payload.rejectedMarkers.join(', ')}
            </p>
          )}
          {payload.unsupportedMarkers && payload.unsupportedMarkers.length > 0 && (
            <p style={{ color: 'var(--vermillion)' }}>
              dropped markers whose passage did not support the sentence:{' '}
              {payload.unsupportedMarkers.join(', ')}
            </p>
          )}
        </div>
      );

    default:
      return null;
  }
}

/**
 * One row per stage with its real duration. The loop is the argument this
 * project makes, so it is inspectable rather than hidden behind a spinner.
 */
export function AgentTimeline({ events }: { events: AgentEvent[] }): React.ReactElement {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const rows = collapse(events);

  if (rows.length === 0) {
    return <p className="p-4 text-[13px] text-ink-faint">The retrieval loop will appear here as it runs.</p>;
  }

  const slowest = Math.max(1, ...rows.map((row) => row.durationMs ?? 0));

  return (
    <ol className="p-2">
      {rows.map((event) => {
        const key = `${event.stage}-${event.iteration}-${event.startedAt}`;
        const open = expanded.has(key);
        const running = event.status === 'started';
        const failed = event.status === 'failed';

        return (
          <li key={key} className="animate-lift">
            <button
              type="button"
              onClick={() =>
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
              className="flex w-full items-center gap-3 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-surface"
            >
              <span className="mono-meta w-5 shrink-0">{event.iteration}</span>

              <span
                className="text-[13px]"
                style={{
                  color: failed
                    ? 'var(--vermillion)'
                    : running
                      ? 'var(--ochre)'
                      : 'var(--ink)',
                }}
              >
                {STAGE_LABEL[event.stage]}
              </span>

              {running && <span className="mono-meta" style={{ color: 'var(--ochre)' }}>running</span>}

              {/* Duration as a bar, relative to the slowest stage in this run.
                  A number alone does not show where the time went. */}
              <span className="ml-auto flex items-center gap-2">
                <span className="h-[2px] w-16 overflow-hidden rounded-full bg-rule">
                  <span
                    className="block h-full transition-[width] duration-300"
                    style={{
                      width: `${((event.durationMs ?? 0) / slowest) * 100}%`,
                      backgroundColor: failed ? 'var(--vermillion)' : 'var(--ink-faint)',
                    }}
                  />
                </span>
                <span className="mono-meta w-11 text-right">{duration(event.durationMs)}</span>
              </span>
            </button>

            {open && (
              <div className="ml-5 border-l border-rule py-2 pl-3 text-[12px] leading-relaxed">
                {event.error ? (
                  <p className="break-words" style={{ color: 'var(--vermillion)' }}>
                    {event.error}
                  </p>
                ) : (
                  <StagePayload event={event} />
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
