import { useEffect, useMemo, useRef, useState } from 'react';
import type { Citation, Document, ResolvedCitation } from '@trace/contracts';
import { api } from '../lib/api.js';
import { HighlightLayer } from './HighlightLayer.js';

function stamp(seconds: number): string {
  const total = Math.floor(seconds);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const SOURCE_LABEL: Record<string, string> = {
  ocr: 'read by OCR',
  asr: 'from the transcript',
  caption: 'from an image caption',
  text: 'embedded text',
};

type Fit = 'width' | 'page' | 'zoom';

/**
 * Marks the cited span inside its surrounding context. The snippet is the
 * literal text of the chunk, so locating it is a string match rather than an
 * offset calculation: charStart and charEnd are absolute within the document,
 * while the context is the chunk plus its neighbours.
 */
function markSnippet(context: string, snippet: string): React.ReactNode {
  const needle = snippet.trim();
  const at = needle.length > 12 ? context.indexOf(needle) : -1;
  if (at < 0) return context;

  return (
    <>
      {context.slice(0, at)}
      <mark className="cited-span">
        {context.slice(at, at + needle.length)}
      </mark>
      {context.slice(at + needle.length)}
    </>
  );
}

function Toolbar({
  label,
  meta,
  fit,
  zoom,
  onFit,
  onZoom,
  onClose,
  scalable,
  embedded = false,
}: {
  label: string;
  meta: string;
  fit: Fit;
  zoom: number;
  onFit: (fit: Fit) => void;
  onZoom: (value: number) => void;
  onClose: () => void;
  scalable: boolean;
  /** The browser's PDF viewer brings its own zoom, so ours would be a second
   *  set of controls that disagree with the first. */
  embedded?: boolean;
}): React.ReactElement {
  return (
    <header className="flex shrink-0 items-center gap-3 rule-hair bg-paper px-4 py-2.5">
      <div className="min-w-0">
        <h2 className="truncate text-[13px] font-medium text-ink">{label}</h2>
        <p className="mono-meta truncate">{meta}</p>
      </div>

      <div className="ml-auto flex items-center gap-1">
        {embedded && <span className="mono-meta mr-2">rendered by your browser</span>}
        {scalable && !embedded && (
          <div className="mr-2 flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                onFit('zoom');
                onZoom(Math.max(0.5, zoom - 0.15));
              }}
              className="h-6 w-6 rounded-sm text-ink-faint hover:bg-surface hover:text-ink"
              aria-label="zoom out"
            >
              −
            </button>
            <span className="mono-meta w-10 text-center">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              onClick={() => {
                onFit('zoom');
                onZoom(Math.min(2.5, zoom + 0.15));
              }}
              className="h-6 w-6 rounded-sm text-ink-faint hover:bg-surface hover:text-ink"
              aria-label="zoom in"
            >
              +
            </button>

            {(['width', 'page'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => onFit(value)}
                className="ml-1 rounded-sm px-1.5 py-0.5 text-[12px]"
                style={{
                  color: fit === value ? 'var(--vermillion)' : 'var(--ink-faint)',
                  transition: `color var(--dur) var(--ease-out)`,
                }}
              >
                fit {value}
              </button>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          className="rounded-sm px-2 py-1 text-[12px] text-ink-faint hover:bg-surface hover:text-ink"
        >
          close
        </button>
      </div>
    </header>
  );
}

/** The cited receipt, printed on parchment like every other piece of evidence. */
function Evidence({
  citation,
  resolved,
  error,
  bare,
}: {
  citation: Citation;
  resolved: ResolvedCitation | null;
  error: string | null;
  bare: boolean;
}): React.ReactElement {
  return (
    <article className="card-surface mx-auto mt-6 max-w-[680px] px-5 py-4 animate-lift">
      <p className="card-eyebrow" style={{ color: 'var(--card-ink-faint)' }}>
        <span style={{ color: 'var(--card-accent)' }}>{citation.marker}</span>
        {citation.page !== null && `  ·  p.${citation.page}`}
        {citation.charStart !== null && `  ·  ch ${citation.charStart}–${citation.charEnd}`}
        {citation.tsStart !== null &&
          `  ·  ${stamp(citation.tsStart)}–${stamp(citation.tsEnd ?? citation.tsStart)}`}
        {`  ·  ${SOURCE_LABEL[citation.source] ?? citation.source}`}
      </p>

      <blockquote
        className="mt-3 border-l-2 pl-4 font-reading text-[16.5px] leading-[1.6]"
        style={{
          borderColor: 'var(--card-accent)',
          color: 'var(--card-ink)',
          // OCR of a dense page can come back as one unbroken run hundreds of
          // characters long. Without somewhere to break, it sets as a single
          // word and walks straight out of the card.
          overflowWrap: 'anywhere',
        }}
      >
        {citation.snippet}
      </blockquote>

      {error && (
        <p className="mt-3 font-mono text-[11px]" style={{ color: 'var(--card-accent)' }}>
          {error}
        </p>
      )}

      {resolved && (
        <details className="mt-4">
          <summary
            className="card-eyebrow cursor-pointer select-none"
            style={{ color: 'var(--card-ink-faint)' }}
          >
            surrounding context
          </summary>
          <p
            className="mt-3 font-reading text-[14px] leading-[1.65] whitespace-pre-wrap"
            style={{ color: 'var(--card-ink-muted)', overflowWrap: 'anywhere' }}
          >
            {markSnippet(resolved.context, citation.snippet)}
          </p>
        </details>
      )}

      {bare && (
        <p className="card-eyebrow mt-4" style={{ color: 'var(--card-ink-faint)' }}>
          this document has no rendered surface, so the span above is the evidence itself
        </p>
      )}
    </article>
  );
}

/**
 * The reading pane. The document is the subject of this interface, so it gets
 * the dominant column; the answer is an annotation on it, not the other way
 * round.
 */
export function DocumentReader({
  document: doc,
  citation,
  onClose,
}: {
  document: Document | null;
  citation: Citation | null;
  onClose: () => void;
}): React.ReactElement {
  const [fit, setFit] = useState<Fit>('width');
  const [zoom, setZoom] = useState(1);
  const [resolved, setResolved] = useState<ResolvedCitation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());

  useEffect(() => {
    let cancelled = false;
    setResolved(null);
    setError(null);
    if (!citation || citation.external) return () => undefined;

    void api
      .resolveCitation(citation.chunkId)
      .then((value) => {
        if (!cancelled) setResolved(value);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [citation]);

  // A text document has no rendered surface — no pages to image, no player, no
  // figure — so its own words are the surface. Mail arrives as text/plain, and
  // without this every message in a connected mailbox opens to a blank pane.
  const plain = doc !== null && doc.modality === 'text';
  useEffect(() => {
    if (!plain || !doc) {
      setBody(null);
      setBodyError(null);
      return () => undefined;
    }

    let cancelled = false;
    setBody(null);
    setBodyError(null);

    void api
      .documentText(doc.id)
      .then((text) => {
        if (!cancelled) setBody(text);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setBodyError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [plain, doc?.id]);

  // Opening a citation scrolls the page into view rather than jumping, so the
  // reader keeps their place in the document.
  useEffect(() => {
    if (!citation?.page) return;
    pageRefs.current.get(citation.page)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [citation, doc?.id]);

  const pages = useMemo(() => {
    const count = doc?.pageCount ?? 0;
    // Only pages that were rendered during extraction can be shown as images.
    // A text-layer PDF renders none, and an <img> pointed at a PDF is a broken
    // image icon, which is what this guard exists to prevent.
    if (!doc || doc.renderedPages === 0) return [];
    return count > 0 ? Array.from({ length: count }, (_, index) => index + 1) : [];
  }, [doc]);

  /** A PDF with no rendered pages is handed to the browser's own viewer, which
   *  renders it properly and honours a #page fragment for the cited page. */
  const embedded = doc !== null && doc.modality === 'pdf' && doc.renderedPages === 0;

  if (citation?.external) {
    return (
      <div className="flex h-full flex-col bg-paper">
        <Toolbar
          label={citation.filename}
          meta="external result · not part of your corpus"
          fit={fit}
          zoom={zoom}
          onFit={setFit}
          onZoom={setZoom}
          onClose={onClose}
          scalable={false}
        />
        <div className="flex-1 overflow-y-auto scroll-slim p-8">
          <article className="card-surface mx-auto max-w-[680px] px-5 py-4 animate-lift">
            <p className="card-eyebrow" style={{ color: 'var(--card-accent)' }}>
              outside the corpus
            </p>
            <p className="mt-3 font-reading text-[14px] leading-[1.6]" style={{ color: 'var(--card-ink)' }}>
              {citation.snippet}
            </p>
            {citation.externalUrl && (
              <a
                href={citation.externalUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-4 block break-all font-mono text-[12px] underline decoration-dotted underline-offset-2"
                style={{ color: 'var(--card-accent)' }}
              >
                {citation.externalUrl}
              </a>
            )}
          </article>
        </div>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center bg-paper">
        <p className="text-[13px] text-ink-faint">Select a document to read it here.</p>
      </div>
    );
  }

  const meta = [
    doc.modality,
    doc.pageCount ? `${doc.pageCount} pages` : null,
    doc.durationSec ? stamp(doc.durationSec) : null,
    `${doc.chunkCount} chunks`,
  ]
    .filter(Boolean)
    .join('  ·  ');

  const media = doc.modality === 'audio' || doc.modality === 'video';
  const start = citation?.tsStart ?? 0;
  const width = fit === 'width' ? '100%' : fit === 'page' ? '620px' : `${Math.round(zoom * 780)}px`;

  return (
    <div className="flex h-full min-w-0 flex-col bg-paper">
      <Toolbar
        label={doc.filename}
        meta={meta}
        fit={fit}
        zoom={zoom}
        onFit={setFit}
        onZoom={setZoom}
        onClose={onClose}
        scalable={pages.length > 0 || doc.modality === 'image' || doc.modality === 'text'}
        embedded={embedded}
      />

      <div className="flex min-h-0 flex-1">
        {/* The page rail. A cited page carries a 2px vermillion tick, which is
            the one place a reader sees where the evidence sits in the whole
            document at a glance. */}
        {pages.length > 1 && (
          <nav className="w-11 shrink-0 overflow-y-auto scroll-slim border-r border-rule bg-paper-sunk py-2">
            {pages.map((page) => {
              const cited = citation?.page === page;
              return (
                <button
                  key={page}
                  type="button"
                  onClick={() =>
                    pageRefs.current.get(page)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }
                  className="relative flex w-full items-center justify-center py-1.5 hover:bg-surface"
                >
                  {cited && (
                    <span
                      className="absolute left-0 top-1 bottom-1 w-[2px] animate-tick"
                      style={{ backgroundColor: 'var(--vermillion)' }}
                    />
                  )}
                  <span
                    className="mono-meta"
                    style={cited ? { color: 'var(--vermillion)' } : undefined}
                  >
                    {page}
                  </span>
                </button>
              );
            })}
          </nav>
        )}

        <div className="min-w-0 flex-1 overflow-y-auto scroll-slim px-6 py-6">
          {media && (
            <div className="mx-auto max-w-[680px] space-y-3 animate-lift">
              <div className="overflow-hidden rounded-sm border border-rule bg-surface">
                {doc.modality === 'video' ? (
                  <video
                    controls
                    className="w-full"
                    // The media fragment makes the browser seek to the cited
                    // moment rather than starting from the beginning.
                    src={`${api.previewUrl(doc.id)}#t=${start}`}
                  />
                ) : (
                  <audio controls className="w-full p-4" src={`${api.previewUrl(doc.id)}#t=${start}`} />
                )}
              </div>

              {/* The cited region as a band on the timeline, so a timestamp is
                  a place in the recording rather than a number. */}
              {doc.durationSec && citation?.tsStart != null && (
                <div>
                  <div className="relative h-8 overflow-hidden rounded-sm bg-paper-sunk">
                    <span
                      className="absolute inset-y-0"
                      style={{
                        left: `${(citation.tsStart / doc.durationSec) * 100}%`,
                        width: `${Math.max(
                          0.8,
                          (((citation.tsEnd ?? citation.tsStart + 4) - citation.tsStart) /
                            doc.durationSec) *
                            100,
                        )}%`,
                        backgroundColor: 'var(--vermillion)',
                      }}
                    />
                  </div>
                  <p className="mono-meta mt-1.5 flex justify-between">
                    <span>00:00</span>
                    <span style={{ color: 'var(--vermillion)' }}>
                      cited {stamp(citation.tsStart)}–{stamp(citation.tsEnd ?? citation.tsStart)}
                    </span>
                    <span>{stamp(doc.durationSec)}</span>
                  </p>
                </div>
              )}
            </div>
          )}

          {doc.modality === 'image' && (
            <figure className="mx-auto animate-lift" style={{ maxWidth: width }}>
              <div className="page-surface relative overflow-hidden rounded-sm">
                <img alt={doc.filename} className="block w-full" src={api.previewUrl(doc.id)} />
                <HighlightLayer active={Boolean(citation)} />
              </div>
            </figure>
          )}

          {pages.length > 0 && (
            <div className="mx-auto space-y-6" style={{ maxWidth: width }}>
              {pages.map((page) => {
                const cited = citation?.page === page;
                return (
                  <div
                    key={page}
                    ref={(node) => {
                      if (node) pageRefs.current.set(page, node);
                      else pageRefs.current.delete(page);
                    }}
                    className="relative"
                  >
                    {cited && (
                      <span
                        className="absolute -left-2 top-0 bottom-0 w-[2px] animate-tick"
                        style={{ backgroundColor: 'var(--vermillion)' }}
                      />
                    )}
                    <div className="page-surface relative overflow-hidden rounded-sm">
                      <img
                        alt={`${doc.filename} page ${page}`}
                        loading="lazy"
                        className="block w-full"
                        src={api.previewUrl(doc.id, page)}
                      />
                      <HighlightLayer active={cited} />
                    </div>
                    <p className="mono-meta mt-1.5 text-center">page {page}</p>
                  </div>
                );
              })}
            </div>
          )}

          {embedded && (
            <div className="animate-lift h-full min-h-[520px]">
              <object
                data={`${api.previewUrl(doc.id)}#page=${citation?.page ?? 1}&view=FitH`}
                type="application/pdf"
                className="h-full w-full rounded-sm"
                style={{ border: '1px solid var(--rule)', minHeight: 520 }}
                aria-label={doc.filename}
              >
                {/* Some browsers refuse to embed a PDF at all. Saying so and
                    offering the file is better than an empty grey rectangle. */}
                <div className="px-6 py-10 text-center">
                  <p className="text-[13px] text-ink-muted">
                    This browser will not display a PDF inline.
                  </p>
                  <a
                    href={api.previewUrl(doc.id)}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="btn btn-secondary mt-3"
                  >
                    Open {doc.filename}
                  </a>
                </div>
              </object>
            </div>
          )}

          {plain && (
            <article className="mx-auto animate-lift" style={{ maxWidth: width }}>
              {body !== null && (
                <div className="page-surface rounded-sm px-7 py-6">
                  {/* The cited span is marked in place, so the evidence is read
                      where it sits rather than only as a quotation below. */}
                  {/* The page stays white in both themes, so its text has to
                      come from the page palette rather than the room's: ink
                      that inverts for dark mode would be white on white. */}
                  <p
                    className="whitespace-pre-wrap font-reading text-[15.5px] leading-[1.72]"
                    style={{ color: 'var(--card-ink)' }}
                  >
                    {citation ? markSnippet(body, citation.snippet) : body}
                  </p>
                </div>
              )}

              {body === null && !bodyError && (
                <p className="mono-meta py-10 text-center">reading the document…</p>
              )}

              {bodyError && (
                <p className="py-10 text-center text-[13px]" style={{ color: 'var(--vermillion)' }}>
                  {bodyError}
                </p>
              )}
            </article>
          )}

          {citation && (
            <Evidence
              citation={citation}
              resolved={resolved}
              error={error}
              // A text document now renders its own words, so the span above is
              // no longer the only place the evidence exists.
              bare={
                pages.length === 0 && !media && !plain && !embedded && doc.modality !== 'image'
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
