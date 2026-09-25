import { useState } from 'react';
import type { AgentEvent, AgentStage } from '@trace/contracts';

const STAGE_LABEL: Record<AgentStage, string> = {
  converse: 'converse',
  analyse: 'analyse',
  retrieve: 'retrieve',
  grade: 'grade',
  sufficiency: 'sufficiency',
  web_search: 'web search',
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
        <p className="text-ink-muted">
          {payload.queries.length} queries · {payload.candidateCount} candidates fused to{' '}
          {payload.chunks.length}
        </p>
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

    case 'synthesise':
      return (
        <p className="text-ink-muted">
          {payload.abstained ? 'abstained' : `${payload.characters} characters`}
        </p>
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
