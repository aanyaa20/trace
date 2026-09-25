import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type {
  Connector,
  ConversationSummary,
  Document,
  KnowledgeBase,
  Modality,
} from '@trace/contracts';
import { api } from '../lib/api.js';
import { EmptyState, PageHeader, Stat } from '../components/ui.js';

const MODALITY_LABEL: Record<Modality, string> = {
  text: 'text',
  pdf: 'PDF',
  image: 'images',
  audio: 'audio',
  video: 'video',
};

const BAND = ['var(--vermillion)', 'var(--moss)', 'var(--ochre)'];

function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

/** Everything the dashboard knows about one corpus, gathered in one place. */
interface Corpus {
  kb: KnowledgeBase;
  documents: Document[];
  threads: ConversationSummary[];
  connectors: Connector[];
}

function chunksOf(documents: Document[]): number {
  return documents.reduce((total, doc) => total + doc.chunkCount, 0);
}

/**
 * What the corpus is made of, as one bar. A retrieval system that spans five
 * modalities should say so where you land, because the mix is what decides
 * whether a citation is a page, a second or an image.
 */
function Composition({ documents }: { documents: Document[] }): React.ReactElement | null {
  const bands = (Object.keys(MODALITY_LABEL) as Modality[])
    .map((modality) => ({
      modality,
      count: documents.filter((doc) => doc.modality === modality).length,
    }))
    .filter((entry) => entry.count > 0);

  if (bands.length === 0) return null;
  const total = documents.length || 1;

  return (
    <div className="mt-3.5">
      <div className="flex h-1.5 overflow-hidden rounded-full">
        {bands.map((entry, index) => (
          <span
            key={entry.modality}
            title={`${entry.count} ${MODALITY_LABEL[entry.modality]}`}
            style={{
              width: `${(entry.count / total) * 100}%`,
              backgroundColor: BAND[index % BAND.length],
              opacity: 0.85,
            }}
          />
        ))}
      </div>
      <p className="mono-meta mt-2">
        {bands.map((entry) => `${entry.count} ${MODALITY_LABEL[entry.modality]}`).join('  ·  ')}
      </p>
    </div>
  );
}

function CorpusCard({ corpus }: { corpus: Corpus }): React.ReactElement {
  const { kb, documents, threads, connectors } = corpus;

  const working = documents.filter(
    (doc) => doc.status === 'queued' || doc.status === 'processing',
  ).length;
  const failed = documents.filter((doc) => doc.status === 'failed').length;

  const touched = [
    ...documents.map((doc) => doc.updatedAt),
    ...threads.map((thread) => thread.lastMessageAt ?? thread.createdAt),
  ].sort()
    .at(-1);

  return (
    <article className="panel flex flex-col px-5 py-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Link to={`/app/kb/${kb.id}`} className="section-title hover:underline">
            {kb.name}
          </Link>
          {kb.description && (
            <p className="mt-1 line-clamp-2 text-[13px] leading-[1.5] text-ink-muted">
              {kb.description}
            </p>
          )}
        </div>
        {touched && <span className="mono-meta shrink-0">{ago(touched)}</span>}
      </div>

      <div className="mt-3.5 flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <span className="text-[13px] text-ink">
          <span className="font-display text-[19px] font-semibold tabular-nums">
            {documents.length}
          </span>{' '}
          <span className="text-ink-muted">documents</span>
        </span>
        <span className="text-[13px] text-ink">
          <span className="font-display text-[19px] font-semibold tabular-nums">
            {chunksOf(documents)}
          </span>{' '}
          <span className="text-ink-muted">passages</span>
        </span>
        <span className="text-[13px] text-ink">
          <span className="font-display text-[19px] font-semibold tabular-nums">
            {threads.filter((thread) => thread.messageCount > 0).length}
          </span>{' '}
          <span className="text-ink-muted">threads</span>
        </span>
      </div>

      <Composition documents={documents} />

      {/* Anything that needs a person is said here rather than left to be
          discovered in the library three clicks away. */}
      {(working > 0 || failed > 0 || connectors.length > 0) && (
        <p className="mono-meta mt-2.5 flex flex-wrap gap-x-3">
          {working > 0 && <span style={{ color: 'var(--ochre)' }}>{working} still ingesting</span>}
          {failed > 0 && (
            <Link
              to={`/app/kb/${kb.id}/library`}
              className="underline decoration-dotted underline-offset-2"
              style={{ color: 'var(--vermillion)' }}
            >
              {failed} failed
            </Link>
          )}
          {connectors.length > 0 && (
            <span>
              {connectors.length} mailbox{connectors.length === 1 ? '' : 'es'} importing
            </span>
          )}
        </p>
      )}

      <div className="mt-4 flex gap-1.5 border-t border-rule pt-3.5">
        <Link to={`/app/kb/${kb.id}/ask`} className="btn btn-primary btn-sm">
          Ask Vera
        </Link>
        <Link to={`/app/kb/${kb.id}/library`} className="btn btn-secondary btn-sm">
          Library
        </Link>
        <Link to={`/app/kb/${kb.id}`} className="btn btn-ghost btn-sm ml-auto">
          Overview
        </Link>
      </div>
    </article>
  );
}

export function Dashboard(): React.ReactElement {
  const navigate = useNavigate();
  const [corpora, setCorpora] = useState<Corpus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const { knowledgeBases } = await api.knowledgeBases();

        // Each corpus's detail is fetched beside the others rather than in
        // sequence: a dashboard that takes as long as its slowest corpus times
        // the number of corpora is a dashboard nobody waits for.
        const detailed = await Promise.all(
          knowledgeBases.map(async (kb): Promise<Corpus> => {
            const [documents, threads, connectors] = await Promise.all([
              api.documents(kb.id).then((response) => response.documents).catch(() => []),
              api.conversations(kb.id).then((response) => response.conversations).catch(() => []),
              api.connectors(kb.id).then((response) => response.connectors).catch(() => []),
            ]);
            return { kb, documents, threads, connectors };
          }),
        );

        if (!cancelled) setCorpora(detailed);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const totals = useMemo(() => {
    const all = corpora ?? [];
    const documents = all.flatMap((corpus) => corpus.documents);
    return {
      corpora: all.length,
      documents: documents.length,
      chunks: chunksOf(documents),
      threads: all.flatMap((corpus) => corpus.threads).filter((thread) => thread.messageCount > 0)
        .length,
      mailboxes: all.flatMap((corpus) => corpus.connectors).length,
      modalities: new Set(documents.map((doc) => doc.modality)).size,
      working: documents.filter((doc) => doc.status === 'queued' || doc.status === 'processing')
        .length,
    };
  }, [corpora]);

  // The last few questions asked anywhere, so returning to the app means
  // returning to what you were asking rather than to a list of folders.
  const recent = useMemo(() => {
    return (corpora ?? [])
      .flatMap((corpus) =>
        corpus.threads
          .filter((thread) => thread.messageCount > 0)
          .map((thread) => ({ thread, kb: corpus.kb })),
      )
      .sort((a, b) =>
        (b.thread.lastMessageAt ?? b.thread.createdAt).localeCompare(
          a.thread.lastMessageAt ?? a.thread.createdAt,
        ),
      )
      .slice(0, 5);
  }, [corpora]);

  const create = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const created = await api.createKnowledgeBase(name.trim());
      setName('');
      void navigate(`/app/kb/${created.id}/library`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-0 flex-1 overflow-y-auto scroll-slim">
      <div className="mx-auto max-w-[1280px] px-8 py-7">
        <PageHeader
          title="Your corpora"
          meta={
            corpora === null
              ? undefined
              : totals.working > 0
                ? `${totals.working} document${totals.working === 1 ? '' : 's'} still ingesting`
                : 'everything indexed'
          }
          lede="A knowledge base is one corpus. Documents never cross between them, and neither do answers."
          actions={
            <button
              type="button"
              onClick={() => setCreating((value) => !value)}
              className="btn btn-secondary"
            >
              {creating ? 'Cancel' : 'New knowledge base'}
            </button>
          }
        />

        {error && (
          <p
            className="mb-4 border-l-2 pl-3 text-[13px]"
            style={{ borderColor: 'var(--vermillion)', color: 'var(--vermillion)' }}
          >
            {error}
          </p>
        )}

        {/* Creating is a rare act and a returning reader should not meet an
            empty text field before they meet their own corpus, so the form is
            opened deliberately rather than sitting at the top of the page. */}
        {creating && (
          <form onSubmit={create} className="panel mb-5 flex gap-1.5 p-3">
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name it after the subject — “Thermodynamics 2026”"
              className="field min-w-0 flex-1"
            />
            <button type="submit" disabled={busy || !name.trim()} className="btn btn-primary">
              Create
            </button>
          </form>
        )}

        {corpora === null ? (
          <>
            <div className="flex flex-wrap gap-2.5">
              {[0, 1, 2, 3].map((index) => (
                <span key={index} className="skeleton h-[74px] min-w-[160px] flex-1 rounded-lg" />
              ))}
            </div>
            <div className="mt-5 grid gap-2.5 lg:grid-cols-2">
              {[0, 1].map((index) => (
                <span key={index} className="skeleton h-[220px] rounded-lg" />
              ))}
            </div>
          </>
        ) : totals.corpora === 0 ? (
          <div className="panel">
            <EmptyState
              title="No knowledge bases yet"
              body="A corpus is a pile of your own material that answers questions about itself. Name one, then upload documents into it or connect a mailbox and let it fill itself."
              action={
                <button type="button" onClick={() => setCreating(true)} className="btn btn-primary">
                  Create one
                </button>
              }
            />
          </div>
        ) : (
          <>
            {/* Everything, across every corpus. The per-corpus numbers are on
                the cards below; this is the answer to "how much have I got". */}
            <div className="flex flex-wrap gap-2.5">
              <Stat
                value={String(totals.documents)}
                label="documents"
                note={`across ${totals.corpora} corpus${totals.corpora === 1 ? '' : 'es'}`}
              />
              <Stat
                value={String(totals.chunks)}
                label="retrievable passages"
                note="every one of them citable"
              />
              <Stat
                value={String(totals.threads)}
                label={totals.threads === 1 ? 'conversation' : 'conversations'}
                note={totals.threads > 0 ? 'citations still live' : 'none asked yet'}
              />
              <Stat
                value={String(totals.modalities)}
                label={totals.modalities === 1 ? 'kind of file' : 'kinds of file'}
                note={
                  totals.mailboxes > 0
                    ? `${totals.mailboxes} mailbox${totals.mailboxes === 1 ? '' : 'es'} importing`
                    : 'no mailbox connected'
                }
              />
            </div>

            <div className="mt-5 grid gap-2.5 lg:grid-cols-2">
              {corpora.map((corpus) => (
                <CorpusCard key={corpus.kb.id} corpus={corpus} />
              ))}
            </div>

            {recent.length > 0 && (
              <section className="mt-7">
                <p className="eyebrow pb-2">pick up where you left off</p>
                <div className="panel">
                  {recent.map(({ thread, kb }) => (
                    <Link
                      key={thread.id}
                      to={`/app/kb/${kb.id}/ask?thread=${thread.id}`}
                      className="list-row group"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-ink">{thread.title}</span>
                        {thread.preview && (
                          <span className="mono-meta block truncate">{thread.preview}</span>
                        )}
                      </span>
                      <span className="mono-meta hidden shrink-0 sm:inline">{kb.name}</span>
                      <span className="mono-meta w-20 shrink-0 text-right">
                        {thread.lastMessageAt ? ago(thread.lastMessageAt) : ago(thread.createdAt)}
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
