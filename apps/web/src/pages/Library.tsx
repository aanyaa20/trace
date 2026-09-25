import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Connector, Document, IngestionEvent, IngestionStage, Modality } from '@trace/contracts';
import { api } from '../lib/api.js';
import { formatBytes, formatDate, formatDuration } from '../lib/format.js';
import { FileIcon, modalityLabel } from '../components/FileIcon.js';
import { IngestionModal, type Accepted } from '../components/IngestionModal.js';
import { Dot, EmptyState, PageHeader, SkeletonRows } from '../components/ui.js';
import { useKb } from './KbLayout.js';

const STAGE_LABEL: Record<IngestionStage, string> = {
  queued: 'queued',
  extracting: 'extracting',
  chunking: 'chunking',
  embedding: 'embedding',
  indexing: 'indexing',
  completed: 'indexed',
  failed: 'failed',
};

const TYPE_FILTERS: Array<{ key: string; label: string; modalities: Modality[] }> = [
  { key: 'all', label: 'View all', modalities: [] },
  { key: 'documents', label: 'Documents', modalities: ['text'] },
  { key: 'pdfs', label: 'PDFs', modalities: ['pdf'] },
  { key: 'images', label: 'Images', modalities: ['image'] },
  { key: 'media', label: 'Audio & video', modalities: ['audio', 'video'] },
];

const PAGE_SIZES = [10, 25, 50];

interface Source {
  key: string;
  title: string;
  note: string;
  documents: Document[];
}

/**
 * The corpus grouped by where each document came from. "Who put this here" is a
 * different question from "what is it", and once a mailbox imports on a timer
 * it is the question a reader asks first about a document they do not
 * recognise.
 */
function sourcesOf(documents: Document[], connectors: Connector[]): Source[] {
  const sources: Source[] = [
    { key: 'all', title: 'All documents', note: 'every source', documents },
  ];

  for (const connector of connectors) {
    sources.push({
      key: `mailbox:${connector.id}`,
      title: connector.label,
      note: connector.mailbox,
      documents: documents.filter((document) => document.connectorId === connector.id),
    });
  }

  const known = new Set(connectors.map((connector) => connector.id));
  const orphaned = documents.filter(
    (document) => document.connectorId !== null && !known.has(document.connectorId),
  );
  if (orphaned.length > 0) {
    sources.push({
      key: 'orphaned',
      title: 'Disconnected mailbox',
      note: 'mailbox removed',
      documents: orphaned,
    });
  }

  sources.push({
    key: 'uploaded',
    title: 'Uploaded',
    note: 'added by hand',
    documents: documents.filter(
      (document) => document.connectorId === null && document.sourceUrl === null,
    ),
  });

  const fromWeb = documents.filter(
    (document) => document.connectorId === null && document.sourceUrl !== null,
  );
  if (fromWeb.length > 0) {
    sources.push({ key: 'web', title: 'From a URL', note: 'fetched', documents: fromWeb });
  }

  return sources;
}

function detail(document: Document): string {
  if (document.pageCount) return `${document.pageCount} page${document.pageCount === 1 ? '' : 's'}`;
  if (document.durationSec) return formatDuration(document.durationSec);
  return `${document.chunkCount} chunk${document.chunkCount === 1 ? '' : 's'}`;
}

function StatusPill({
  document,
  live,
}: {
  document: Document;
  live: IngestionEvent | undefined;
}): React.ReactElement {
  const active = document.status === 'queued' || document.status === 'processing';
  const label = live ? STAGE_LABEL[live.stage] : document.status;
  const tone =
    document.status === 'failed'
      ? 'var(--vermillion)'
      : active
        ? 'var(--ochre)'
        : 'var(--moss)';

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tone }} />
      <span className="mono-meta" style={{ color: tone }}>
        {label}
      </span>
      {active && live && (
        <span className="mono-meta">{Math.round(live.progress * 100)}%</span>
      )}
    </span>
  );
}


/**
 * How this document was actually read. A corpus is only worth trusting if you
 * can see what happened to a file on the way in — whether a PDF had a text
 * layer or had to be looked at, how many passages it became, and what a
 * citation pointing here will therefore be able to carry.
 */
function extraction(document: Document): string {
  switch (document.modality) {
    case 'pdf':
      if (document.renderedPages > 0) {
        return document.pageCount
          ? `${document.renderedPages} of ${document.pageCount} pages read by OCR`
          : `${document.renderedPages} pages read by OCR`;
      }
      return 'text layer read directly, no OCR needed';
    case 'image':
      return 'text read out of the image by OCR';
    case 'audio':
    case 'video':
      return 'speech transcribed with timestamps';
    default:
      return 'read directly';
  }
}

/** What a citation pointing at this document is able to resolve to. */
function coordinates(document: Document): string {
  switch (document.modality) {
    case 'pdf':
      return 'page + character range';
    case 'audio':
    case 'video':
      return 'timestamp range';
    case 'image':
      return 'the figure itself';
    default:
      return 'character range';
  }
}

function origin(document: Document): string {
  if (document.connectorId) return 'a connected mailbox';
  if (document.sourceUrl) return 'a URL';
  return 'uploaded';
}

function Fact({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-rule py-2">
      <span className="mono-meta shrink-0">{label}</span>
      <span className="text-right text-[12.5px] text-ink">{value}</span>
    </div>
  );
}

function SourceInspector({
  document,
  live,
  onRead,
  onClose,
}: {
  document: Document;
  live: IngestionEvent | undefined;
  onRead: () => void;
  onClose: () => void;
}): React.ReactElement {
  const extent =
    document.pageCount !== null
      ? `${document.pageCount} page${document.pageCount === 1 ? '' : 's'}`
      : document.durationSec !== null
        ? formatDuration(document.durationSec)
        : modalityLabel(document.modality);

  return (
    <aside className="panel h-fit p-4">
      <div className="flex items-start gap-2">
        <p className="eyebrow flex-1">selected source</p>
        <button
          type="button"
          onClick={onClose}
          className="text-[12px] text-ink-faint hover:text-ink"
          aria-label="close the inspector"
        >
          close
        </button>
      </div>

      <h3 className="mt-1.5 font-display text-[18px] font-semibold break-words text-ink">
        {document.filename}
      </h3>

      <div className="mt-2.5">
        <StatusPill document={document} live={live} />
      </div>

      <p className="mt-3 text-[12.5px] leading-relaxed text-ink-muted">{extraction(document)}</p>

      <div className="mt-3">
        <Fact label="a citation carries" value={coordinates(document)} />
        <Fact
          label="passages"
          value={`${document.chunkCount} retrievable`}
        />
        <Fact label="extent" value={extent} />
        <Fact label="size" value={formatBytes(document.sizeBytes)} />
        <Fact label="arrived by" value={origin(document)} />
        <Fact label="added" value={formatDate(document.createdAt)} />
      </div>

      {document.error && (
        <p
          className="mt-3 border-l-2 pl-2.5 font-mono text-[11px] leading-relaxed break-words"
          style={{ borderColor: 'var(--vermillion)', color: 'var(--vermillion)' }}
        >
          {document.error}
        </p>
      )}

      <button
        type="button"
        disabled={document.status !== 'indexed' && document.chunkCount === 0}
        onClick={onRead}
        className="btn btn-secondary btn-sm mt-4 w-full"
      >
        Read it
      </button>
    </aside>
  );
}

export function Library(): React.ReactElement {
  const { kb, library, connectors } = useKb();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [showUrl, setShowUrl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  /** The document whose index detail is open beside the list. */
  const [inspecting, setInspecting] = useState<string | null>(null);
  /** The batch just handed over, watched until every file settles. */
  const [accepted, setAccepted] = useState<Accepted[] | null>(null);
  /** The document whose remove has been pressed once and awaits confirming. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const sources = useMemo(
    () => sourcesOf(library.documents, connectors),
    [library.documents, connectors],
  );

  // The selected source lives in the URL, so a view of one mailbox is a link
  // that survives a reload and can be sent to someone.
  const selectedKey = params.get('source') ?? 'all';
  const selected = sources.find((source) => source.key === selectedKey) ?? sources[0]!;

  const filtered = useMemo(() => {
    const filter = TYPE_FILTERS.find((entry) => entry.key === typeFilter) ?? TYPE_FILTERS[0]!;
    const needle = query.trim().toLowerCase();
    return selected.documents.filter((document) => {
      if (filter.modalities.length > 0 && !filter.modalities.includes(document.modality)) {
        return false;
      }
      return needle.length === 0 || document.filename.toLowerCase().includes(needle);
    });
  }, [selected, typeFilter, query]);

  // A filter or a source change that left the viewer on page 7 of 2 would show
  // an empty table and look like data loss.
  useEffect(() => {
    setPage(1);
  }, [selectedKey, typeFilter, query, pageSize]);

  // Looked up across the whole corpus rather than the current page, so paging
  // away from a document does not silently close its detail.
  const inspected = inspecting
    ? (library.documents.find((document) => document.id === inspecting) ?? null)
    : null;

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pageCount);
  const rows = filtered.slice((current - 1) * pageSize, current * pageSize);

  const select = (key: string): void => {
    if (key === 'all') params.delete('source');
    else params.set('source', key);
    setParams(params, { replace: true });
  };

  const upload = async (files: FileList | File[] | null): Promise<void> => {
    const list = files ? [...files] : [];
    if (list.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.upload(kb.id, list);
      setAccepted(response.documents.map(({ id, filename }) => ({ id, filename })));
      await library.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const ingestUrl = async (): Promise<void> => {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.ingestUrl(kb.id, url.trim());
      setAccepted(response.documents.map(({ id, filename }) => ({ id, filename })));
      setUrl('');
      setShowUrl(false);
      await library.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main
      className="flex min-h-0 flex-1 flex-col bg-paper"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void upload(event.dataTransfer.files);
      }}
    >
      <div className="shrink-0 px-8 pt-5">
        <PageHeader
          title={selected.title}
          meta={`${selected.documents.length} document${selected.documents.length === 1 ? '' : 's'} · ${selected.note}`}
          actions={
            <>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search this source…"
                className="field w-56"
              />
              <button
                type="button"
                onClick={() => setShowUrl((value) => !value)}
                className="btn btn-secondary"
              >
                Add URL
              </button>
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={busy}
                className="btn btn-primary"
              >
                Upload
              </button>
            </>
          }
        />

        {/* Sources were a second vertical rail beside the module rail, which
            spent a fifth of the window on seven words. As a row of counts they
            say the same thing and give the table its width back. */}
        <div className="-mt-1 flex flex-wrap items-center gap-1.5">
          {sources.map((source) => {
            const active = source.key === selected.key;
            return (
              <button
                key={source.key}
                type="button"
                onClick={() => select(source.key)}
                className="flex items-center gap-2 rounded-full border px-3 py-1 text-[12px]"
                style={{
                  borderColor: active ? 'var(--rule-strong)' : 'var(--rule)',
                  backgroundColor: active ? 'var(--surface-raised)' : 'transparent',
                  color: active ? 'var(--ink)' : 'var(--ink-muted)',
                  transition: 'color var(--dur) var(--ease-out)',
                }}
              >
                {source.key.startsWith('mailbox:') && <Dot tone="var(--moss)" />}
                <span className="max-w-[210px] truncate">{source.title}</span>
                <span className="mono-meta">{source.documents.length}</span>
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => void navigate(`/app/kb/${kb.id}/mailboxes`)}
            className="btn btn-ghost btn-sm"
          >
            + mailbox
          </button>
        </div>

        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(event) => void upload(event.target.files)}
        />

        {showUrl && (
          <div className="animate-lift mt-3 flex gap-1.5">
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void ingestUrl();
              }}
              placeholder="https://…"
              disabled={busy}
              autoFocus
              className="field min-w-0 flex-1"
            />
            <button
              type="button"
              onClick={() => void ingestUrl()}
              disabled={busy || !url.trim()}
              className="btn btn-primary"
            >
              Add
            </button>
          </div>
        )}

        {(error ?? (dragging ? 'Drop to upload' : null)) && (
          <p
            className="mt-3 text-[13px]"
            style={{ color: error ? 'var(--vermillion)' : 'var(--ink-muted)' }}
          >
            {error ?? 'Drop to upload'}
          </p>
        )}

        <div className="mt-4 flex items-center gap-1 border-b border-rule">
          {TYPE_FILTERS.map((filter) => {
            const active = filter.key === typeFilter;
            return (
              <button
                key={filter.key}
                type="button"
                onClick={() => setTypeFilter(filter.key)}
                className="relative px-3 py-2 text-[13px]"
                style={{
                  color: active ? 'var(--ink)' : 'var(--ink-faint)',
                  transition: 'color var(--dur) var(--ease-out)',
                }}
              >
                {filter.label}
                {active && (
                  <span
                    className="absolute inset-x-2 -bottom-px h-[2px] rounded-full"
                    style={{ backgroundColor: 'var(--vermillion)' }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scroll-slim px-8 pb-4">
        {library.loading && library.documents.length === 0 ? (
          <div className="panel mt-4">
            <SkeletonRows rows={6} />
          </div>
        ) : rows.length === 0 ? (
          <div className="panel mt-4">
            <EmptyState
              title={
                selected.documents.length === 0
                  ? selected.key.startsWith('mailbox:')
                    ? 'This mailbox has not imported anything yet'
                    : 'Nothing in this source yet'
                  : 'No documents match that filter'
              }
              body={
                selected.documents.length === 0
                  ? 'Drop a file anywhere on this page, add a URL, or connect a mailbox and let the corpus arrive on its own.'
                  : undefined
              }
              action={
                selected.documents.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => fileInput.current?.click()}
                    className="btn btn-primary"
                  >
                    Upload files
                  </button>
                ) : (
                  <button type="button" onClick={() => setTypeFilter('all')} className="btn btn-secondary">
                    Clear filter
                  </button>
                )
              }
            />
          </div>
        ) : (
          /* One hairline-ruled table rather than a stack of cards with gaps.
             The old rows were 80px tall, so six documents filled a window that
             now holds twenty. */
          <div
            className="mt-4 grid items-start gap-4"
            style={{
              gridTemplateColumns: inspected ? 'minmax(0, 1fr) 300px' : 'minmax(0, 1fr)',
            }}
          >
            <div className="panel min-w-0">
            <div className="panel-head">
              <span className="eyebrow min-w-0 flex-1">name</span>
              <span className="eyebrow w-20 text-right">size</span>
              <span className="eyebrow w-16 text-right">type</span>
              <span className="eyebrow w-28 text-right">added</span>
              <span className="eyebrow w-32 text-right">status</span>
              <span className="w-[118px]" />
            </div>

            {rows.map((document) => {
              const readable = document.status === 'indexed' || document.chunkCount > 0;
              return (
                <div key={document.id} className="list-row group">
                  <button
                    type="button"
                    disabled={!readable}
                    onClick={() => void navigate(`/app/kb/${kb.id}/ask?doc=${document.id}`)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
                  >
                    <FileIcon modality={document.modality} size={28} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-ink">
                        {document.filename}
                      </span>
                      <span className="mono-meta">{detail(document)}</span>
                    </span>
                  </button>

                  <span className="mono-meta w-20 shrink-0 text-right">
                    {formatBytes(document.sizeBytes)}
                  </span>
                  <span className="mono-meta w-16 shrink-0 text-right">
                    {modalityLabel(document.modality)}
                  </span>
                  <span className="mono-meta w-28 shrink-0 text-right">
                    {formatDate(document.createdAt)}
                  </span>
                  <span className="flex w-32 shrink-0 justify-end">
                    <StatusPill document={document} live={library.progress[document.id]} />
                  </span>

                  <span className="flex w-[118px] shrink-0 items-center justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => setInspecting(document.id)}
                      className="text-[12px] text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-ink"
                      aria-label={`inspect ${document.filename}`}
                    >
                      inspect
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        // Two presses, because this cannot be undone: the
                        // document, its chunks and its vectors all go.
                        if (confirming !== document.id) {
                          setConfirming(document.id);
                          return;
                        }
                        setConfirming(null);
                        void api
                          .deleteDocument(document.id)
                          .then(() => {
                            if (inspecting === document.id) setInspecting(null);
                            return library.refresh();
                          })
                          .catch((cause: unknown) =>
                            setError(
                              cause instanceof Error
                                ? `could not remove ${document.filename}: ${cause.message}`
                                : String(cause),
                            ),
                          );
                      }}
                      onBlur={() => setConfirming((id) => (id === document.id ? null : id))}
                      className={`text-[12px] transition-opacity hover:text-ink ${
                        confirming === document.id
                          ? 'opacity-100'
                          : 'text-ink-faint opacity-0 group-hover:opacity-100'
                      }`}
                      style={
                        confirming === document.id ? { color: 'var(--vermillion)' } : undefined
                      }
                      aria-label={
                        confirming === document.id
                          ? `confirm removing ${document.filename}`
                          : `remove ${document.filename}`
                      }
                    >
                      {confirming === document.id ? 'remove?' : 'remove'}
                    </button>
                  </span>
                </div>
              );
            })}
            </div>

            {inspected && (
              <SourceInspector
                document={inspected}
                live={library.progress[inspected.id]}
                onRead={() => void navigate(`/app/kb/${kb.id}/ask?doc=${inspected.id}`)}
                onClose={() => setInspecting(null)}
              />
            )}
          </div>
        )}

        {rows.some((row) => row.error) && (
          <ul className="mt-3 space-y-1">
            {rows
              .filter((row) => row.error)
              .map((row) => (
                <li
                  key={row.id}
                  className="font-mono text-[11px] leading-relaxed break-words"
                  style={{ color: 'var(--vermillion)' }}
                >
                  {row.filename}: {row.error}
                </li>
              ))}
          </ul>
        )}
      </div>

      {filtered.length > 0 && (
        <div className="flex shrink-0 items-center gap-3 border-t border-rule px-8 py-2.5">
          <label className="mono-meta flex items-center gap-1.5">
            Rows per page
            <select
              value={pageSize}
              onChange={(event) => setPageSize(Number(event.target.value))}
              className="rounded border border-rule bg-surface px-1.5 py-0.5 text-[12px] text-ink focus:outline-none"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>

          <span className="mono-meta ml-auto">
            {(current - 1) * pageSize + 1}–{Math.min(current * pageSize, filtered.length)} of{' '}
            {filtered.length}
          </span>

          <div className="flex gap-1">
            <button
              type="button"
              disabled={current <= 1}
              onClick={() => setPage(current - 1)}
              className="btn btn-secondary btn-sm"
            >
              ‹
            </button>
            <button
              type="button"
              disabled={current >= pageCount}
              onClick={() => setPage(current + 1)}
              className="btn btn-secondary btn-sm"
            >
              ›
            </button>
          </div>
        </div>
      )}

      {accepted && accepted.length > 0 && (
        <IngestionModal
          accepted={accepted}
          documents={library.documents}
          progress={library.progress}
          onClose={() => setAccepted(null)}
          onAsk={(documentId) => {
            setAccepted(null);
            // ?doc= opens it in the reader and scopes the first question to
            // it; ?new= keeps that question out of whatever thread happened to
            // be open last.
            void navigate(
              documentId
                ? `/app/kb/${kb.id}/ask?doc=${documentId}&new=1`
                : `/app/kb/${kb.id}/ask?new=1`,
            );
          }}
        />
      )}
    </main>
  );
}
