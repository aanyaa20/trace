import type { Citation } from '@trace/contracts';
import type { AnswerState } from '../lib/useAnswer.js';

const MARKER = /\[\^(\d+)\]/g;

interface Claim {
  text: string;
  markers: number[];
}

/**
 * Splits the answer into sentences so hovering a citation can fade everything
 * it does not support. The unit of grounding is the claim, and a claim is
 * roughly a sentence; without this the reader has to guess how far back from
 * the marker the evidence reaches.
 */
function claimsOf(text: string): Claim[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((part) => part.length > 0)
    .map((part) => ({
      text: part,
      markers: [...part.matchAll(MARKER)].map((match) => Number(match[1])),
    }));
}

function Marker({
  marker,
  citation,
  active,
  onSelect,
  onActive,
}: {
  marker: number;
  citation: Citation | undefined;
  /** Lit from the other side too: hovering a source card lights its numeral. */
  active: boolean;
  onSelect: (citation: Citation) => void;
  onActive: (marker: number | null) => void;
}): React.ReactElement {
  if (!citation) {
    return (
      <span
        className="ml-px font-mono text-[12px] font-medium text-ink-faint"
        style={{ position: 'relative', top: '-0.62em' }}
      >
        {marker}
      </span>
    );
  }

  const where = [
    citation.filename,
    citation.page !== null ? `page ${citation.page}` : null,
    citation.tsStart !== null ? `at ${Math.floor(citation.tsStart / 60)}:${String(Math.floor(citation.tsStart % 60)).padStart(2, '0')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <button
      type="button"
      onClick={() => onSelect(citation)}
      onMouseEnter={() => onActive(marker)}
      onMouseLeave={() => onActive(null)}
      onFocus={() => onActive(marker)}
      onBlur={() => onActive(null)}
      // A bare superscript numeral reads as a typo to anyone who has not been
      // told what it is. The tinted box makes it look like something you can
      // press, and the title says where it goes before you press it.
      title={`Open the source: ${where}`}
      aria-label={`source ${marker}: ${where}`}
      className={`citation-marker${active ? ' is-active' : ''}`}
    >
      {marker}
    </button>
  );
}

function renderClaim(
  claim: Claim,
  citations: Citation[],
  active: number | null,
  onSelect: (citation: Citation) => void,
  onActive: (marker: number | null) => void,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Markers are matched as a run rather than one at a time. A model that cites
  // three sources on one claim was rendering three separate boxes that the
  // line could break between, leaving a numeral stranded at the start of the
  // next line ahead of its own full stop. A run is one object: deduplicated,
  // and unbreakable.
  const pattern = /(?:\[\^\d+\])+/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(claim.text)) !== null) {
    if (match.index > cursor) nodes.push(claim.text.slice(cursor, match.index));

    const markers = [...new Set([...match[0].matchAll(MARKER)].map((one) => Number(one[1])))];
    nodes.push(
      <span key={`r${key++}`} className="marker-run">
        {markers.map((marker) => (
          <Marker
            key={marker}
            marker={marker}
            citation={citations.find((entry) => entry.marker === marker)}
            active={active === marker}
            onSelect={onSelect}
            onActive={onActive}
          />
        ))}
      </span>,
    );
    cursor = match.index + match[0].length;
  }

  if (cursor < claim.text.length) nodes.push(claim.text.slice(cursor));
  return nodes;
}

export function Answer({
  state,
  onSelectCitation,
  activeMarker,
  onActiveMarker,
  compact = false,
  bubble = false,
}: {
  state: AnswerState;
  onSelectCitation: (citation: Citation) => void;
  /** Shared with the source cards, so a hover on either side lights both. */
  activeMarker?: number | null;
  onActiveMarker?: (marker: number | null) => void;
  /**
   * Set for a turn already answered. The answer in hand is the one being read,
   * so an earlier one is set smaller rather than given equal weight — but it
   * renders through this same component, because a stored citation has to
   * behave exactly like a live one.
   */
  compact?: boolean;
  /**
   * Set when this answer is a turn in the thread rather than the page's one
   * subject. The bubble already sets the measure, the size and the colour, so
   * the answer stops carrying its own, and the trace line moves out to sit
   * under the bubble where a messenger puts the timestamp.
   */
  bubble?: boolean;
}): React.ReactElement | null {
  if (state.status === 'idle') return null;

  if (state.status === 'failed') {
    return bubble ? (
      <span className="text-ink-muted">{state.error}</span>
    ) : (
      <div
        className="rounded-sm border-l-2 bg-paper-sunk px-4 py-3 text-[13px] text-ink"
        style={{ borderColor: 'var(--vermillion)' }}
      >
        {state.error}
      </div>
    );
  }

  const active = activeMarker ?? null;
  const setActive = (marker: number | null): void => onActiveMarker?.(marker);

  return (
    <div className={bubble ? undefined : 'animate-lift'}>
      <div
        className={
          bubble
            ? 'font-reading text-[15.5px] leading-[1.62]'
            : `measure font-reading leading-[1.55] text-ink ${compact ? 'text-[16px]' : 'text-[20px]'}`
        }
        style={bubble ? undefined : { fontOpticalSizing: 'auto' }}
      >
        {claimsOf(state.text).map((claim, index) => {
          const cited = active !== null && claim.markers.includes(active);
          const faded = active !== null && !cited;

          return (
            <span
              key={index}
              style={{
                opacity: faded ? 0.35 : 1,
                backgroundColor: cited ? 'var(--highlight)' : 'transparent',
                transition: `opacity var(--dur) var(--ease-out), background-color var(--dur) var(--ease-out)`,
              }}
            >
              {renderClaim(claim, state.citations, active, onSelectCitation, setActive)}{' '}
            </span>
          );
        })}

        {state.status === 'streaming' && (
          <span
            className="ml-0.5 inline-block h-[0.95em] w-[2px] animate-pulse align-baseline"
            style={{ backgroundColor: 'var(--vermillion)' }}
          />
        )}
      </div>

      {state.trace && !bubble && (
        <p className={compact ? 'mono-meta mt-3' : 'mono-meta mt-5'}>
          {state.trace.mode} · {state.trace.iterations} iteration
          {state.trace.iterations === 1 ? '' : 's'} · {(state.trace.totalMs / 1000).toFixed(1)}s ·{' '}
          {state.trace.events.length} events
        </p>
      )}
    </div>
  );
}
