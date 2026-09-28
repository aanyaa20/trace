import type { Citation } from '@trace/contracts';
import type { AnswerState } from '../lib/useAnswer.js';
import { citationLabel } from '../lib/citationLabel.js';

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

  const where = citationLabel(citation);

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

/**
 * The answer's layout, from the few Markdown forms synthesis is allowed to
 * use: paragraphs, bulleted and numbered lists, and pipe tables. The prompt
 * invites a list or a table when one is asked for ("list all the years"), and
 * rendering them as running text printed the asterisks and dashes literally.
 */
type Block =
  | { kind: 'p'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] };

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

function cellsOf(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

export function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  const flush = (): void => {
    const joined = paragraph.join(' ').trim();
    if (joined) blocks.push({ kind: 'p', text: joined });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (line.trim().startsWith('|')) {
      flush();
      const run: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        // The |---|---| rule under a header carries no content.
        if (!/^\s*\|?[\s:-]+(\|[\s:-]+)+\|?\s*$/.test(lines[i]!)) run.push(cellsOf(lines[i]!));
        i += 1;
      }
      i -= 1;
      const [header = [], ...rows] = run;
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    const list = BULLET.test(line) ? 'ul' : NUMBERED.test(line) ? 'ol' : null;
    if (list) {
      flush();
      const marker = list === 'ul' ? BULLET : NUMBERED;
      const last = blocks[blocks.length - 1];
      const item = line.replace(marker, '');
      if (last && last.kind === list) last.items.push(item);
      else blocks.push({ kind: list, items: [item] });
      continue;
    }
    // A heading line reads as a short bold paragraph; the answer is prose,
    // not a document with its own outline.
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push({ kind: 'p', text: `**${heading[1]}**` });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (paragraph.length === 0 && last && (last.kind === 'ul' || last.kind === 'ol') && /^\s{2,}/.test(line)) {
      last.items[last.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** **bold** inside a run of text; everything else is left as typed. */
function inline(text: string, key: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter((part) => part.length > 0);
  return parts.map((part, index) =>
    /^\*\*[^*]+\*\*$/.test(part) ? (
      <strong key={`${key}-${index}`} className="font-semibold">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
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
    if (match.index > cursor) nodes.push(...inline(claim.text.slice(cursor, match.index), `t${key}`));

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

  if (cursor < claim.text.length) nodes.push(...inline(claim.text.slice(cursor), 'tail'));
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
        {blocksOf(state.text).map((block, blockIndex) => {
          const claims = (text: string): React.ReactNode =>
            claimsOf(text).map((claim, index) => {
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
            });
          const gap = blockIndex > 0 ? 'mt-3' : '';

          if (block.kind === 'p') {
            return (
              <p key={blockIndex} className={gap}>
                {claims(block.text)}
              </p>
            );
          }
          if (block.kind === 'table') {
            return (
              <div key={blockIndex} className={`answer-table-wrap ${gap}`}>
                <table className="answer-table">
                  <thead>
                    <tr>
                      {block.header.map((cell, index) => (
                        <th key={index}>{claims(cell)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, index) => (
                          <td key={index}>{claims(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          const List = block.kind === 'ol' ? 'ol' : 'ul';
          return (
            <List key={blockIndex} className={`answer-list ${block.kind === 'ol' ? 'is-numbered' : ''} ${gap}`}>
              {block.items.map((item, index) => (
                <li key={index}>{claims(item)}</li>
              ))}
            </List>
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
