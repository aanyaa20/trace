import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ConversationSummary, Document, EvalRun, Modality } from '@trace/contracts';
import { api } from '../lib/api.js';
import { FileIcon, modalityTint } from '../components/FileIcon.js';
import { EmptyState, PageHeader, Panel, Stat } from '../components/ui.js';
import { useKb } from './KbLayout.js';
import { ago } from '../lib/format.js';
import { displayName, isMail, mailParts } from '../lib/mail.js';

const MODALITY_LABEL: Record<Modality, string> = {
  text: 'text',
  pdf: 'pdf',
  image: 'image',
  audio: 'audio',
  video: 'video',
};


/**
 * The knowledge base's front door. A corpus is a thing you return to, so the
 * questions it answers on arrival are what is in it, what has arrived since,
 * and what was being asked when you left.
 */
export function Overview(): React.ReactElement {
  const { kb, library, connectors } = useKb();
  const navigate = useNavigate();
  const [threads, setThreads] = useState<ConversationSummary[]>([]);
  const [runs, setRuns] = useState<EvalRun[]>([]);

  useEffect(() => {
    let current = true;
    void api
      .conversations(kb.id)
      .then((list) => current && setThreads(list.conversations))
      .catch(() => undefined);
    void api
      .evalRuns(kb.id)
      .then((list) => current && setRuns(list.runs))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [kb.id]);

  const documents = library.documents;

  const stats = useMemo(() => {
    const chunks = documents.reduce((total, doc) => total + doc.chunkCount, 0);
    const modalities = new Set(documents.map((doc) => doc.modality));
    const working = documents.filter(
      (doc) => doc.status !== 'indexed' && doc.status !== 'failed',
    ).length;
    const failed = documents.filter((doc) => doc.status === 'failed').length;
    return { chunks, modalities, working, failed };
  }, [documents]);

  const recent = useMemo(
    () =>
      [...documents]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 6),
    [documents],
  );

  const answered = threads.filter((thread) => thread.messageCount > 0).slice(0, 5);
  const byModality = (Object.keys(MODALITY_LABEL) as Modality[])
    .map((modality) => ({
      modality,
      count: documents.filter((doc) => doc.modality === modality).length,
    }))
    .filter((entry) => entry.count > 0);

  const total = documents.length || 1;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto scroll-slim bg-paper">
      <div className="mx-auto max-w-[1280px] px-8 py-7">
        <PageHeader
          title={kb.name}
          meta={
            stats.working > 0
              ? `${stats.working} still ingesting`
              : stats.failed > 0
                ? `${stats.failed} failed to ingest`
                : 'every document indexed'
          }
          {...(kb.description ? { lede: kb.description } : {})}
          actions={
            <>
              <button
                type="button"
                onClick={() => void navigate(`/app/kb/${kb.id}/library`)}
                className="btn btn-secondary"
              >
                Add documents
              </button>
              <button
                type="button"
                onClick={() => void navigate(`/app/kb/${kb.id}/ask`)}
                className="btn btn-primary"
              >
                Ask Folio
              </button>
            </>
          }
        />

        <div className="flex flex-wrap gap-2.5">
          <Stat value={String(documents.length)} label="documents" note={`${byModality.length} modalities`} />
          <Stat value={String(stats.chunks)} label="retrievable chunks" note="each one citable" />
          <Stat
            value={String(connectors.length)}
            label={connectors.length === 1 ? 'connected mailbox' : 'connected mailboxes'}
            note={connectors.length > 0 ? 'importing on a timer' : 'none connected'}
          />
          <Stat
            value={String(threads.filter((thread) => thread.messageCount > 0).length)}
            label="conversations"
            note={runs.length > 0 ? `${runs.length} evaluation runs` : 'no evaluation yet'}
          />
        </div>

        {/* What the corpus is made of. A retrieval system that spans five
            modalities should say so on the page you land on, because the mix
            is what makes a citation a page, a second or an image. */}
        {byModality.length > 0 && (
          <div className="mt-5">
            <p className="eyebrow pb-2">composition</p>
            <div className="flex h-2 overflow-hidden rounded-full">
              {byModality.map((entry) => (
                <span
                  key={entry.modality}
                  title={`${entry.count} ${MODALITY_LABEL[entry.modality]}`}
                  style={{
                    width: `${(entry.count / total) * 100}%`,
                    // Each modality in its icon's colour. Cycling three theme
                    // colours gave text and audio the same one.
                    backgroundColor: modalityTint(entry.modality),
                    opacity: 0.85,
                  }}
                />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {byModality.map((entry) => (
                <span key={entry.modality} className="mono-meta inline-flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: modalityTint(entry.modality) }}
                  />
                  {MODALITY_LABEL[entry.modality]} · {entry.count}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Two equal columns that fill the row, lined up with the stat cards
            above; stacked on a narrow screen. */}
        <div className="mt-7 grid gap-5 lg:grid-cols-2">
          <Panel
            title="recent documents"
            action={
              <button
                type="button"
                onClick={() => void navigate(`/app/kb/${kb.id}/library`)}
                className="btn btn-ghost btn-sm"
              >
                open library
              </button>
            }
          >
            {recent.length === 0 ? (
              <EmptyState
                title="Nothing ingested yet"
                body="Upload a file, add a URL, or connect a mailbox."
              />
            ) : (
              <ul>
                {recent.map((doc: Document) => (
                  <li key={doc.id}>
                    <button
                      type="button"
                      onClick={() => void navigate(`/app/kb/${kb.id}/ask?doc=${doc.id}`)}
                      className="list-row"
                    >
                      <FileIcon modality={doc.modality} size={28} mail={isMail(doc)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-ink">{displayName(doc)}</span>
                        <span className="mono-meta">
                          {isMail(doc)
                            ? `mail${mailParts(doc).sender ? ` · from ${mailParts(doc).sender}` : ''}`
                            : `${doc.chunkCount} chunk${doc.chunkCount === 1 ? '' : 's'} · ${MODALITY_LABEL[doc.modality]}`}
                        </span>
                      </span>
                      <span className="mono-meta shrink-0">{ago(doc.createdAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="recent conversations"
            action={
              <button
                type="button"
                onClick={() => void navigate(`/app/kb/${kb.id}/threads`)}
                className="btn btn-ghost btn-sm"
              >
                all threads
              </button>
            }
          >
            {answered.length === 0 ? (
              <EmptyState title="No questions asked yet" />
            ) : (
              <ul>
                {answered.map((thread) => (
                  <li key={thread.id}>
                    <button
                      type="button"
                      onClick={() => void navigate(`/app/kb/${kb.id}/ask?thread=${thread.id}`)}
                      className="list-row"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-ink">{thread.title}</span>
                        <span className="mono-meta">
                          {Math.floor(thread.messageCount / 2)} asked
                        </span>
                      </span>
                      <span className="mono-meta shrink-0">
                        {thread.lastMessageAt ? ago(thread.lastMessageAt) : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </main>
  );
}
