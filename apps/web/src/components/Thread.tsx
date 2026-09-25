import type { AgentEvent, Citation, Message } from '@trace/contracts';
import type { AnswerState } from '../lib/useAnswer.js';
import { Answer } from './Answer.js';
import { Groundedness } from './Groundedness.js';
import { VERA, stageLabel } from './Vera.js';

/**
 * The conversation, as a conversation. Turns alternate sides, the newest is at
 * the foot where the composer already has your eye, and a stored turn is built
 * from the same parts as the one still streaming — one component, so a
 * citation asked yesterday behaves exactly like a citation asked a second ago.
 */

function stateOf(message: Message): AnswerState {
  return {
    status: 'complete',
    text: message.content,
    events: [],
    citations: message.citations,
    trace: message.trace,
    abstained: message.abstained,
    error: null,
  };
}

function whereOf(citation: Citation): string {
  if (citation.page !== null) return `p.${citation.page}`;
  if (citation.tsStart !== null) {
    const minutes = Math.floor(citation.tsStart / 60);
    const seconds = String(Math.floor(citation.tsStart % 60)).padStart(2, '0');
    return `${minutes}:${seconds}`;
  }
  return citation.external ? 'external' : '';
}

function metaOf(state: AnswerState): string | null {
  if (!state.trace) return null;
  const { mode, iterations, totalMs, events } = state.trace;
  const passes = `${iterations} iteration${iterations === 1 ? '' : 's'}`;
  return `${mode} · ${passes} · ${(totalMs / 1000).toFixed(1)}s · ${events.length} events`;
}

/** Citations gathered under the document they point into. */
interface SourceGroup {
  documentId: string;
  filename: string;
  items: Citation[];
}

function groupByDocument(citations: Citation[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const citation of citations) {
    const existing = groups.get(citation.documentId);
    if (existing) {
      existing.items.push(citation);
      continue;
    }
    groups.set(citation.documentId, {
      documentId: citation.documentId,
      filename: citation.filename,
      items: [citation],
    });
  }
  return [...groups.values()];
}

/**
 * The sources under an answer, one row per document.
 *
 * Ten citations into one PDF used to print its name ten times, truncated to
 * the point where every chip read the same — a legend that names the same
 * thing repeatedly tells you nothing about which numeral goes where. The
 * filename is said once and the numerals sit beside it carrying the only part
 * that actually differs: the page, or the second.
 */
function Sources({
  citations,
  activeMarker,
  onSelectCitation,
  onActiveMarker,
}: {
  citations: Citation[];
  activeMarker: number | null;
  onSelectCitation: (citation: Citation) => void;
  onActiveMarker?: (marker: number | null) => void;
}): React.ReactElement | null {
  if (citations.length === 0) return null;

  return (
    <ul className="chat-sources">
      {groupByDocument(citations).map((group) => (
        <li key={group.documentId} className="source-group">
          <span className="source-file" title={group.filename}>
            {group.filename}
          </span>
          <span className="source-marks">
            {group.items.map((citation) => (
              <button
                key={citation.chunkId}
                type="button"
                onClick={() => onSelectCitation(citation)}
                onMouseEnter={() => onActiveMarker?.(citation.marker)}
                onMouseLeave={() => onActiveMarker?.(null)}
                onFocus={() => onActiveMarker?.(citation.marker)}
                onBlur={() => onActiveMarker?.(null)}
                title={`Open ${group.filename} at ${whereOf(citation) || 'this passage'}`}
                className={`source-mark${activeMarker === citation.marker ? ' is-active' : ''}`}
              >
                <span className="n">{citation.marker}</span>
                {whereOf(citation) && <span className="where">{whereOf(citation)}</span>}
              </button>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Said({ text, same }: { text: string; same: boolean }): React.ReactElement {
  return (
    <div className={`chat-row is-me${same ? ' is-same' : ''}`}>
      <div className="chat-stack">
        <div className="bubble bubble-me">{text}</div>
      </div>
    </div>
  );
}

function Answered({
  state,
  same,
  activeMarker,
  onSelectCitation,
  onActiveMarker,
  sources = true,
  children,
}: {
  state: AnswerState;
  same: boolean;
  activeMarker: number | null;
  onSelectCitation: (citation: Citation) => void;
  onActiveMarker?: (marker: number | null) => void;
  /**
   * Chips under the bubble. The turn in hand already has the sources panel —
   * full cards, with the snippet — so it does not need them; a turn from
   * earlier does, because the panel that belonged to it scrolled away with the
   * answer and left its numerals pointing at nothing.
   */
  sources?: boolean;
  /** The grounding strip, which only the live turn can account for. */
  children?: React.ReactNode;
}): React.ReactElement {
  const meta = metaOf(state);

  return (
    <div className={`chat-row${same ? ' is-same' : ''}`}>
      <span className="chat-avatar" aria-hidden>
        {VERA.slice(0, 1)}
      </span>

      <div className="chat-stack">
        <div className={`bubble bubble-vera${state.abstained ? ' is-abstained' : ''}`}>
          <Answer
            bubble
            state={state}
            onSelectCitation={onSelectCitation}
            activeMarker={activeMarker}
            onActiveMarker={onActiveMarker}
          />
        </div>

        {sources && (
          <Sources
            citations={state.citations}
            activeMarker={activeMarker}
            onSelectCitation={onSelectCitation}
            onActiveMarker={onActiveMarker}
          />
        )}

        {children}

        {meta && <p className="chat-meta">{meta}</p>}
      </div>
    </div>
  );
}

/**
 * Vera is working. The bubble stands where her answer will, so the thread does
 * not jump when the first token lands. Three dots say "hold on"; the line
 * under them says what for, because the gap before the first token is the
 * whole loop — analysis, retrieval, grading, sometimes another pass — and
 * naming the stage it is in is more honest than a spinner.
 */
export function Typing({ events }: { events: AgentEvent[] }): React.ReactElement {
  return (
    <div className="chat-row">
      <span className="chat-avatar" aria-hidden>
        {VERA.slice(0, 1)}
      </span>
      <div className="chat-stack">
        <div className="bubble bubble-vera" aria-label={`${VERA} is working`}>
          <span className="typing" role="status">
            <span />
            <span />
            <span />
          </span>
        </div>
        <p className="chat-meta">{stageLabel(events)}</p>
      </div>
    </div>
  );
}

export function Thread({
  messages,
  asked,
  live,
  onSelectCitation,
  activeMarker,
  onActiveMarker,
}: {
  /** Oldest first, as the history endpoint returns them. */
  messages: Message[];
  /** The question just sent, before the turn it belongs to is stored. */
  asked: string | null;
  live: AnswerState;
  onSelectCitation: (citation: Citation) => void;
  activeMarker?: number | null;
  onActiveMarker?: (marker: number | null) => void;
}): React.ReactElement | null {
  // An assistant row with no text is a run that failed or never streamed.
  // Showing the question with nothing under it reads as a bug in the thread
  // rather than in that one answer, so the pair is dropped.
  const turns = messages.filter(
    (message) => message.role === 'user' || message.content.trim().length > 0,
  );

  const active = activeMarker ?? null;
  const waiting = live.status === 'streaming' && live.text.length === 0;
  const showLive = live.status !== 'idle' && !waiting;

  if (turns.length === 0 && asked === null && live.status === 'idle') return null;

  return (
    <div className="chat">
      {turns.map((message, index) =>
        message.role === 'user' ? (
          <Said
            key={message.id}
            text={message.content}
            same={index > 0 && turns[index - 1]!.role === 'user'}
          />
        ) : (
          <Answered
            key={message.id}
            state={stateOf(message)}
            same={index > 0 && turns[index - 1]!.role === 'assistant'}
            activeMarker={active}
            onSelectCitation={onSelectCitation}
            onActiveMarker={onActiveMarker}
          />
        ),
      )}

      {asked !== null && (
        <Said text={asked} same={turns.length > 0 && turns[turns.length - 1]!.role === 'user'} />
      )}

      {waiting && <Typing events={live.events} />}

      {showLive && (
        <Answered
          state={live}
          same={false}
          sources={false}
          activeMarker={active}
          onSelectCitation={onSelectCitation}
          onActiveMarker={onActiveMarker}
        >
          <Groundedness events={live.events} abstained={live.abstained} />
        </Answered>
      )}
    </div>
  );
}
