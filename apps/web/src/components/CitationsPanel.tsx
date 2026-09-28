import { useState } from 'react';
import type { Citation, Modality } from '@trace/contracts';
import { locationOf } from '../lib/citationLabel.js';

const MODALITY_TAG: Record<Modality, string> = {
  text: 'txt',
  pdf: 'pdf',
  image: 'img',
  audio: 'aud',
  video: 'vid',
};

/** The machine-verified coordinate, in the same words as every other label,
 *  plus the character span when there is one. Set in mono: it is not prose. */
function locator(citation: Citation): string {
  if (citation.external) return locationOf(citation) || 'external';
  const where = locationOf(citation);
  const span =
    citation.charStart !== null && citation.charEnd !== null
      ? `chars ${citation.charStart}–${citation.charEnd}`
      : '';
  return [where, span].filter(Boolean).join(' · ') || citation.modality;
}

/**
 * Sources as parchment index cards. The palette split is the argument: the room
 * is dark green, and anything that is a cited receipt is printed on parchment,
 * so a reader can tell evidence from interface without reading a word.
 *
 * Folded by default. Every answer already carries its citation chips, and
 * pressing one opens the page in the reader, so a full stack of cards under
 * every reply repeated that and pushed the thread apart. The cards are one
 * press away for anyone who wants the quoted passages side by side.
 */
export function CitationsPanel({
  citations,
  onSelect,
  selected,
  activeMarker,
  onActiveMarker,
}: {
  citations: Citation[];
  onSelect: (citation: Citation) => void;
  selected: string | null;
  /** Shared with the answer, so a hover on either side lights both. */
  activeMarker?: number | null;
  onActiveMarker?: (marker: number | null) => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  if (citations.length === 0) {
    return <p className="text-[13px] text-ink-faint">No citations. Nothing was claimed.</p>;
  }

  const files = new Set(citations.map((citation) => citation.documentId)).size;

  return (
    <section>
      <header className="border-t border-rule pt-3">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="group flex w-full items-baseline justify-between gap-3 text-left"
        >
          <h2 className="eyebrow">
            <span
              aria-hidden
              className="mr-1.5 inline-block transition-transform"
              style={{
                transform: expanded ? 'rotate(90deg)' : 'none',
                transitionDuration: 'var(--dur)',
              }}
            >
              ›
            </span>
            {expanded ? 'hide sources' : 'show sources'}
          </h2>
          <span className="mono-meta group-hover:text-ink-muted">
            {citations.length} receipt{citations.length === 1 ? '' : 's'} · {files} file
            {files === 1 ? '' : 's'}
          </span>
        </button>
      </header>

      {expanded && (
        <ul className="mt-3 space-y-2">
          {citations.map((citation) => {
            const lifted = activeMarker === citation.marker;
            const open = selected === citation.chunkId;

            return (
              <li key={`${citation.marker}-${citation.chunkId}`}>
                <button
                  type="button"
                  onClick={() => onSelect(citation)}
                  onMouseEnter={() => onActiveMarker?.(citation.marker)}
                  onMouseLeave={() => onActiveMarker?.(null)}
                  onFocus={() => onActiveMarker?.(citation.marker)}
                  onBlur={() => onActiveMarker?.(null)}
                  className="card-surface block w-full px-[14px] py-[15px] text-left"
                  style={{
                    borderColor: lifted || open ? 'var(--card-accent)' : 'var(--card-rule)',
                    transform: lifted ? 'translateY(-2px)' : 'none',
                    transition: `transform var(--dur) var(--ease-out), border-color var(--dur) var(--ease-out)`,
                  }}
                >
                  <span className="flex items-baseline gap-2">
                    <span
                      className="font-mono text-[12px] font-medium tabular-nums"
                      style={{ color: 'var(--card-accent)' }}
                    >
                      {citation.marker}
                    </span>

                    <span
                      className="card-eyebrow rounded-[2px] border px-1 py-px"
                      style={{ borderColor: 'var(--card-rule)', color: 'var(--card-ink-faint)' }}
                    >
                      {MODALITY_TAG[citation.modality]}
                    </span>

                    <span
                      className="truncate text-[13px] font-medium"
                      style={{ color: 'var(--card-ink)' }}
                    >
                      {citation.filename}
                    </span>

                    <span
                      className="ml-auto shrink-0 font-mono text-[12px] tabular-nums"
                      style={{ color: 'var(--card-ink-faint)' }}
                    >
                      {locator(citation)}
                    </span>
                  </span>

                  {/* No wash here. The excerpt IS the cited span, so marking
                      all of it highlights nothing — and a yellow wash laid over
                      parchment is two highlights stacked, which is what made
                      this card hard to read. The parchment already says this is
                      evidence; the rule down the left says it is quoted. The
                      highlight is kept for the reader, where a span really does
                      sit inside surrounding text that is not cited. */}
                  <span
                    className="mt-2.5 block border-l-2 pl-3 font-reading text-[13.5px] leading-[1.6]"
                    style={{
                      borderColor: lifted || open ? 'var(--card-accent)' : 'var(--card-rule)',
                      color: 'var(--card-ink)',
                      transition: 'border-color var(--dur) var(--ease-out)',
                      // OCR of a dense page can return a run with no spaces in
                      // it; without this the card is widened by one long word
                      // and the text runs under its own edge.
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {citation.snippet}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
