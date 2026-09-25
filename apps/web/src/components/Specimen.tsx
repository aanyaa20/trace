import { useEffect, useMemo, useState } from 'react';
import { VERA } from './Vera.js';

/**
 * The product, running, on the front page.
 *
 * A still screenshot of an answer proves the layout exists. What actually
 * needs proving is the sequence: that the wait is a real search, that the
 * answer arrives a claim at a time, and that each numeral resolves to a
 * source. So the panel performs it on a loop — ask, think, write, cite, link
 * — using the same bubbles, markers and chips the reading room uses.
 */

interface Segment {
  text?: string;
  marker?: number;
}

const QUESTION = 'How does chunking handle page boundaries?';

const ANSWER: Segment[] = [
  { text: 'Chunks never cross a page boundary' },
  { marker: 1 },
  { text: ', so every chunk keeps a single page number. Splits land on sentence boundaries, with about 150 characters of overlap' },
  { marker: 1 },
  { text: '. Transcript segments are the exception — they are merged instead, because one segment is only a few seconds of speech' },
  { marker: 2 },
  { text: '.' },
];

const SOURCES = [
  { marker: 1, filename: 'handbook.pdf', where: 'p.2' },
  { marker: 2, filename: 'lecture.mp4', where: '0:14' },
];

/** What the loop is doing while you wait, read off the same stage names the
 *  agent really reports. */
const STAGES = [
  'working out what you are asking',
  'searching your documents',
  'weighing each passage',
];

type Token = { word: string } | { marker: number };

/** Words and markers as one stream, so the reveal can advance through both. */
function tokenise(segments: Segment[]): Token[] {
  return segments.flatMap<Token>((segment) => {
    if (segment.marker !== undefined) return [{ marker: segment.marker }];
    return (segment.text ?? '')
      .split(/(\s+)/)
      .filter((part) => part.length > 0)
      .map((word) => ({ word }));
  });
}

type Phase = 'ask' | 'think' | 'write' | 'sources' | 'link' | 'hold';

export function Specimen(): React.ReactElement {
  const tokens = useMemo(() => tokenise(ANSWER), []);

  // Anyone who has asked for less motion gets the finished answer, complete
  // and still. The panel's job is to show what an answer looks like; the
  // performance is how it does that, not what it is.
  const still = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
    [],
  );

  const [phase, setPhase] = useState<Phase>(still ? 'hold' : 'ask');
  const [shown, setShown] = useState(still ? tokens.length : 0);
  const [stage, setStage] = useState(0);
  const [lit, setLit] = useState<number | null>(null);

  // One timeline, advanced by whichever phase is running. Each step schedules
  // the next rather than a single clock driving them all, so a slow frame
  // delays the sequence instead of desynchronising it.
  useEffect(() => {
    if (still) return;

    if (phase === 'ask') {
      const id = window.setTimeout(() => setPhase('think'), 900);
      return () => window.clearTimeout(id);
    }

    if (phase === 'think') {
      const ticking = window.setInterval(
        () => setStage((value) => Math.min(value + 1, STAGES.length - 1)),
        620,
      );
      const id = window.setTimeout(() => setPhase('write'), 2000);
      return () => {
        window.clearInterval(ticking);
        window.clearTimeout(id);
      };
    }

    if (phase === 'write') {
      const id = window.setInterval(() => {
        setShown((value) => {
          if (value >= tokens.length) return value;
          return value + 1;
        });
      }, 42);
      return () => window.clearInterval(id);
    }

    if (phase === 'sources') {
      const id = window.setTimeout(() => setPhase('link'), 1000);
      return () => window.clearTimeout(id);
    }

    if (phase === 'link') {
      // The payoff: each numeral lights with the source it resolves to, which
      // is the one thing a still image of this panel can never show.
      const first = window.setTimeout(() => setLit(1), 200);
      const second = window.setTimeout(() => setLit(2), 1500);
      const done = window.setTimeout(() => {
        setLit(null);
        setPhase('hold');
      }, 2900);
      return () => {
        window.clearTimeout(first);
        window.clearTimeout(second);
        window.clearTimeout(done);
      };
    }

    const id = window.setTimeout(() => {
      setShown(0);
      setStage(0);
      setPhase('ask');
    }, 3200);
    return () => window.clearTimeout(id);
  }, [phase, still, tokens.length]);

  // Writing finishes when the last token lands, not on a timer that has to be
  // kept in step with the reveal rate.
  useEffect(() => {
    if (phase === 'write' && shown >= tokens.length) setPhase('sources');
  }, [phase, shown, tokens.length]);

  const writing = phase === 'write';
  const answering = phase === 'write' || phase === 'sources' || phase === 'link' || phase === 'hold';
  const showSources = phase === 'sources' || phase === 'link' || phase === 'hold';

  return (
    <figure className="row-surface overflow-hidden rounded-lg border border-rule p-4 sm:p-5">
      <figcaption className="eyebrow">an answer, as it appears</figcaption>

      {/* Held at the height of the finished answer so the page does not jump
          each time the loop restarts. */}
      <div className="chat mt-3.5 min-h-[264px]">
        <div className="chat-row is-me">
          <div className="chat-stack">
            <div className="bubble bubble-me spec-in">{QUESTION}</div>
          </div>
        </div>

        {phase === 'think' && (
          <div className="chat-row spec-in">
            <span className="chat-avatar" aria-hidden>
              {VERA.slice(0, 1)}
            </span>
            <div className="chat-stack">
              <div className="bubble bubble-vera">
                <span className="typing">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
              <p className="chat-meta">{STAGES[stage]}</p>
            </div>
          </div>
        )}

        {answering && (
          <div className="chat-row">
            <span className="chat-avatar" aria-hidden>
              {VERA.slice(0, 1)}
            </span>
            <div className="chat-stack">
              <div className="bubble bubble-vera">
                {tokens.slice(0, shown).map((token, index) =>
                  'marker' in token ? (
                    <span
                      key={index}
                      className={`citation-marker spec-marker${lit === token.marker ? ' is-active' : ''}`}
                    >
                      {token.marker}
                    </span>
                  ) : (
                    <span key={index}>{token.word}</span>
                  ),
                )}
                {writing && <span className="spec-caret" />}
              </div>

              {showSources && (
                <ul className="spec-sources">
                  {SOURCES.map((source, index) => (
                    <li
                      key={source.marker}
                      className="spec-chip"
                      style={{ animationDelay: `${index * 120}ms` }}
                    >
                      <span
                        className={`chat-source${lit === source.marker ? ' is-active' : ''}`}
                      >
                        <span className="n">{source.marker}</span>
                        <span className="who">{source.filename}</span>
                        <span className="where">{source.where}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {showSources && (
                <p className="chat-meta">
                  press a number and the source opens at that page or second
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </figure>
  );
}
