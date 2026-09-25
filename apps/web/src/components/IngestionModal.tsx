import { useEffect, useRef } from 'react';
import type { Document, IngestionEvent, IngestionStage } from '@trace/contracts';

/**
 * What is happening to the files you just handed over.
 *
 * Ingestion is the one slow thing in this product a person deliberately
 * starts, and it is several steps long: a PDF is read, split, embedded and
 * indexed before it can be cited. Dropping a file and getting a row that says
 * "queued" tells you nothing about whether to wait or go away, so the steps
 * are named as they happen and the modal says when every file is done.
 */

const STAGE_LABEL: Record<IngestionStage, string> = {
  queued: 'waiting its turn',
  extracting: 'reading the file',
  chunking: 'splitting into passages',
  embedding: 'building the index',
  indexing: 'storing the vectors',
  completed: 'ready to cite',
  failed: 'nothing to index',
};

/** The batch this modal is watching, as handed back by the upload. */
export interface Accepted {
  id: string;
  filename: string;
}

interface Row {
  id: string;
  filename: string;
  stage: IngestionStage;
  progress: number;
  done: boolean;
  failed: boolean;
  chunks: number;
  error: string | null;
}

function rowsOf(
  accepted: Accepted[],
  documents: Document[],
  progress: Record<string, IngestionEvent>,
): Row[] {
  return accepted.map((entry) => {
    const document = documents.find((candidate) => candidate.id === entry.id);
    const live = progress[entry.id];

    // The persisted row is the authority on whether this finished; the stream
    // is the authority on where it is while it has not. A stream event can
    // arrive after the refresh that already marked it indexed.
    const failed = document?.status === 'failed' || live?.stage === 'failed';
    const done = document?.status === 'indexed' || live?.stage === 'completed';

    const stage: IngestionStage = failed
      ? 'failed'
      : done
        ? 'completed'
        : (live?.stage ?? 'queued');

    return {
      id: entry.id,
      filename: entry.filename,
      stage,
      progress: done || failed ? 1 : (live?.progress ?? 0),
      done,
      failed,
      chunks: document?.chunkCount ?? 0,
      error: document?.error ?? null,
    };
  });
}

export function IngestionModal({
  accepted,
  documents,
  progress,
  onClose,
  onAsk,
}: {
  accepted: Accepted[];
  documents: Document[];
  progress: Record<string, IngestionEvent>;
  onClose: () => void;
  /** Receives the document to ask about, so the reader opens on it. */
  onAsk: (documentId: string | null) => void;
}): React.ReactElement {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const rows = rowsOf(accepted, documents, progress);
  const settled = rows.filter((row) => row.done || row.failed).length;
  const failed = rows.filter((row) => row.failed).length;
  const finished = settled === rows.length;

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const heading = finished
    ? failed > 0
      ? rows.length === 1
        ? 'Nothing to index in this one'
        : `${rows.length - failed} of ${rows.length} indexed`
      : rows.length === 1
        ? 'Indexed and ready to cite'
        : `All ${rows.length} indexed`
    : rows.length === 1
      ? 'Processing your document'
      : `Processing ${rows.length} documents`;

  return (
    <div
      className="modal-backdrop"
      // Dismissing by clicking away is safe here: closing watches the work, it
      // does not stop it. Ingestion continues either way.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal animate-lift" role="dialog" aria-modal="true" aria-label={heading}>
        <div className="flex items-start gap-3 border-b border-rule px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 className="section-title">{heading}</h2>
            <p className="mono-meta mt-0.5">
              {finished
                ? 'you can close this'
                : `${settled} of ${rows.length} done · this keeps running if you close`}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="text-[12px] text-ink-faint hover:text-ink"
          >
            close
          </button>
        </div>

        <ul className="max-h-[46vh] overflow-y-auto scroll-slim px-5 py-2">
          {rows.map((row) => (
            <li key={row.id} className="border-b border-rule py-3 last:border-b-0">
              <div className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{row.filename}</span>
                <span
                  className="mono-meta shrink-0"
                  style={{
                    color: row.failed
                      ? 'var(--vermillion)'
                      : row.done
                        ? 'var(--moss)'
                        : 'var(--ochre)',
                  }}
                >
                  {STAGE_LABEL[row.stage]}
                </span>
              </div>

              {/* The bar is the only thing on screen that says how much longer,
                  so a failure fills it in the failure colour rather than
                  leaving it stranded part-way as though still working. */}
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-paper-sunk">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.round(row.progress * 100)}%`,
                    backgroundColor: row.failed
                      ? 'var(--vermillion)'
                      : row.done
                        ? 'var(--moss)'
                        : 'var(--ochre)',
                    transition: 'width var(--dur) var(--ease-out)',
                  }}
                />
              </div>

              {row.done && row.chunks > 0 && (
                <p className="mono-meta mt-1.5">
                  {row.chunks} passage{row.chunks === 1 ? '' : 's'}, each one citable
                </p>
              )}

              {row.failed && (
                <p
                  className="mt-1.5 font-mono text-[11px] leading-relaxed break-words"
                  style={{ color: 'var(--vermillion)' }}
                >
                  {row.error ?? 'this file could not be read'}
                </p>
              )}
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2 border-t border-rule px-5 py-3">
          <button type="button" onClick={onClose} className="btn btn-secondary btn-sm">
            {finished ? 'Done' : 'Run in the background'}
          </button>
          {finished && failed < rows.length && (
            <button
              type="button"
              // The first file that made it in. Sending the reader to the
              // corpus at large after an upload drops exactly the thing the
              // press was about.
              onClick={() => onAsk(rows.find((row) => row.done)?.id ?? null)}
              className="btn btn-primary btn-sm ml-auto"
            >
              {rows.length === 1 ? 'Ask about it' : 'Ask about them'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
