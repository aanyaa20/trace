import { useEffect, useMemo, useState } from 'react';
import type { AgentEvent } from '@trace/contracts';

/**
 * The assistant has a name because an empty text box does not explain itself.
 * Vera, from veritas: her whole job is that a claim she makes resolves to the
 * page it came from, and that she says so when it cannot.
 */
export const VERA = 'Vera';

/**
 * What each stage of the loop is actually doing, in the words a reader would
 * use. These are driven by real events off the agent bus rather than a timed
 * sequence, so the label on screen is the stage the loop is in — the same
 * honesty the trace drawer provides, at a glance.
 */
export const STAGE_COPY: Record<string, string> = {
  analyse: 'working out what you are asking',
  retrieve: 'searching your documents',
  grade: 'weighing each passage',
  sufficiency: 'deciding whether that is enough',
  web_search: 'looking outside your corpus',
  synthesise: 'writing, with citations',
  citations: 'checking every citation resolves',
};

/**
 * The stage the loop is actually in, in a reader's words. The typing bubble in
 * the thread uses this: three dots say "hold on", and this says what for — the
 * same honesty the trace drawer gives, in the space a messenger allows.
 */
export function stageLabel(events: AgentEvent[]): string {
  const last = [...events].reverse().find((event) => event.stage in STAGE_COPY);
  return last ? (STAGE_COPY[last.stage] ?? 'thinking') : 'thinking';
}

function Face({
  mood,
  size = 44,
}: {
  mood: 'greeting' | 'thinking';
  size?: number;
}): React.ReactElement {
  const thinking = mood === 'thinking';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden
      className={thinking ? 'vera-bob-fast' : 'vera-bob'}
    >
      {/* antenna */}
      <line x1="24" y1="6" x2="24" y2="12" stroke="var(--ink-faint)" strokeWidth="1.5" />
      <circle cx="24" cy="5" r="2.5" fill="var(--vermillion)" className="vera-blip" />

      {/* head */}
      <rect
        x="8"
        y="12"
        width="32"
        height="26"
        rx="9"
        fill="var(--surface)"
        stroke="var(--ink-faint)"
        strokeWidth="1.5"
      />

      {/* eyes: they blink while idle and scan side to side while working */}
      <g className={thinking ? 'vera-scan' : 'vera-blink'}>
        <circle cx="18" cy="24" r="3" fill="var(--vermillion)" />
        <circle cx="30" cy="24" r="3" fill="var(--vermillion)" />
      </g>

      {/* a small mouth rule, because a face without one reads as a machine */}
      <line
        x1="20"
        y1="32"
        x2="28"
        y2="32"
        stroke="var(--ink-faint)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />

      {/* shoulders */}
      <path
        d="M14 44c0-4.4 4.5-6 10-6s10 1.6 10 6"
        stroke="var(--ink-faint)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The greeting. It arrives from the left on first load, says what this box is
 * for, and goes away for good once a question has been asked — a mascot that
 * keeps introducing itself to someone who is already working is noise.
 */
export function VeraGreeting({
  corpusName,
  documentCount,
  onDismiss,
  onSuggest,
  suggestions,
  standalone = false,
}: {
  corpusName: string;
  documentCount: number;
  onDismiss: () => void;
  onSuggest: (question: string) => void;
  suggestions: string[];
  /** On the landing page there is no corpus yet and nothing to dismiss to, so
   *  she introduces the product rather than a particular shelf of documents. */
  standalone?: boolean;
}): React.ReactElement {
  return (
    <div className="vera-enter flex items-start gap-3.5 py-2">
      <span className="shrink-0 pt-1">
        <Face mood="greeting" size={52} />
      </span>

      <div className="min-w-0 flex-1">
        {/* The bubble's notch points back at her, so the words are hers. */}
        <div className="vera-bubble relative rounded-xl border border-rule bg-surface px-4 py-3.5">
          <p className="font-display text-[17px] font-semibold leading-snug text-ink">
            Hi, I&rsquo;m {VERA}.
          </p>
          <p className="measure mt-1.5 text-[13px] leading-relaxed text-ink-muted">
            {standalone ? (
              <>
                Ask me anything about your own documents — PDFs, scans, recordings, images, mail.
                Every sentence I write carries a number that opens the exact page, span or second it
                came from. If your documents cannot answer it, I will say so rather than guess.
              </>
            ) : (
              <>
                Ask me anything about the {documentCount} document
                {documentCount === 1 ? '' : 's'} in {corpusName} — the PDFs, the scans, the
                recordings, the mail. Every sentence I write carries a number that opens the exact
                page, span or second it came from. If your documents cannot answer it, I will say so
                rather than guess.
              </>
            )}
          </p>

          {suggestions.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {suggestions.map((question) => (
                <button
                  key={question}
                  type="button"
                  onClick={() => onSuggest(question)}
                  className="rounded-full border border-rule px-3 py-1 text-[12px] text-ink-muted hover:border-ink-faint hover:text-ink"
                  style={{ transition: 'color var(--dur) var(--ease-out)' }}
                >
                  {question}
                </button>
              ))}
            </div>
          )}

          {!standalone && (
            <button
              type="button"
              onClick={onDismiss}
              className="mono-meta absolute right-3 top-3 hover:text-ink"
              aria-label="dismiss the greeting"
            >
              ✕
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * What she is doing right now. The ring is a spinner; the line beneath it is
 * the stage the loop has actually reached, and the count is how many passages
 * have come back so far.
 */
export function VeraThinking({ events }: { events: AgentEvent[] }): React.ReactElement {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed((Date.now() - started) / 1000), 100);
    return () => window.clearInterval(timer);
  }, []);

  const { label, retrieved, iteration } = useMemo(() => {
    const last = [...events].reverse().find((event) => event.stage in STAGE_COPY);

    // The payload union is discriminated by its own stage field, which is what
    // narrows `chunks` into existence here.
    const retrieved = [...events]
      .reverse()
      .reduce<number>((found, event) => {
        if (found > 0) return found;
        const payload = event.payload;
        return payload && payload.stage === 'retrieve' ? payload.chunks.length : 0;
      }, 0);

    return {
      label: last ? (STAGE_COPY[last.stage] ?? 'thinking') : 'thinking',
      retrieved,
      iteration: last?.iteration ?? 1,
    };
  }, [events]);

  return (
    <div className="flex items-center gap-3.5 py-3">
      <span className="relative flex shrink-0 items-center justify-center">
        {/* The ring turns while she works. It is a spinner, not a progress
            bar, because the loop can take another pass and a bar that went
            backwards would be a lie. */}
        <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden className="absolute">
          <circle cx="28" cy="28" r="25" fill="none" stroke="var(--rule)" strokeWidth="2" />
          <circle
            cx="28"
            cy="28"
            r="25"
            fill="none"
            stroke="var(--vermillion)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="40 117"
            className="vera-spin"
          />
        </svg>
        <Face mood="thinking" size={38} />
      </span>

      <div className="min-w-0">
        <p className="flex items-baseline gap-2 text-[14px] text-ink">
          <span>
            {VERA} is {label}
          </span>
          <span className="vera-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        </p>
        <p className="mono-meta mt-0.5">
          {elapsed.toFixed(1)}s
          {iteration > 1 ? ` · pass ${iteration}` : ''}
          {retrieved > 0 ? ` · ${retrieved} passages in hand` : ''}
        </p>
      </div>
    </div>
  );
}
