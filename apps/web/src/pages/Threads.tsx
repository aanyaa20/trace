import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ConversationSummary } from '@trace/contracts';
import { api } from '../lib/api.js';
import { useKb } from './KbLayout.js';
import { EmptyState, PageHeader, SkeletonRows } from '../components/ui.js';

function when(iso: string): string {
  const date = new Date(iso);
  const days = (Date.now() - date.getTime()) / 86_400_000;
  if (days < 1) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * Every thread in this knowledge base. The switcher in the reading room is for
 * moving between two or three; this is for finding one from a month ago, which
 * is a different job and needs the question itself rather than a title.
 */
export function Threads(): React.ReactElement {
  const { kb } = useKb();
  const navigate = useNavigate();
  const [threads, setThreads] = useState<ConversationSummary[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setThreads((await api.conversations(kb.id)).conversations);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [kb.id]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const remove = async (id: string): Promise<void> => {
    // The turns go with it, so this asks first. A thread is the only record of
    // what was answered and what it was answered from.
    if (!window.confirm('Delete this thread and every answer in it?')) return;
    try {
      await api.deleteConversation(id);
      setThreads((current) => current.filter((thread) => thread.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const start = async (): Promise<void> => {
    try {
      const created = await api.createConversation(kb.id);
      void navigate(`/app/kb/${kb.id}/ask?thread=${created.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // An empty thread is a door someone opened and walked away from. It is not
  // worth a row of its own in a list you are searching.
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return threads
      .filter((thread) => thread.messageCount > 0)
      .filter(
        (thread) =>
          needle.length === 0 ||
          thread.title.toLowerCase().includes(needle) ||
          (thread.preview ?? '').toLowerCase().includes(needle),
      );
  }, [threads, query]);

  const empties = threads.length - threads.filter((thread) => thread.messageCount > 0).length;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto scroll-slim bg-paper">
      <div className="mx-auto max-w-[1280px] px-8 py-7">
        <PageHeader
          title="Conversations"
          meta={`${shown.length} thread${shown.length === 1 ? '' : 's'}${
            empties > 0 ? ` · ${empties} empty, hidden` : ''
          }`}
          lede="Every question asked of this corpus, with the answers exactly as they were verified when they were given."
          actions={
            <>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search questions…"
                className="field w-56"
              />
              <button type="button" onClick={() => void start()} className="btn btn-primary">
                New thread
              </button>
            </>
          }
        />

        {error && (
          <p className="mt-4 text-[13px]" style={{ color: 'var(--vermillion)' }}>
            {error}
          </p>
        )}

        <div className="panel">
          {loading ? (
            <SkeletonRows rows={5} />
          ) : shown.length === 0 ? (
            <EmptyState
              title={query ? 'No thread matches that' : 'No questions asked yet'}
              body={
                query
                  ? undefined
                  : 'Vera answers from the documents in this corpus, with a citation on every claim.'
              }
              action={
                query ? (
                  <button type="button" onClick={() => setQuery('')} className="btn btn-secondary">
                    Clear search
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void navigate(`/app/kb/${kb.id}/ask`)}
                    className="btn btn-primary"
                  >
                    Ask the first question
                  </button>
                )
              }
            />
          ) : (
            <ul>
              {shown.map((thread) => (
                <li key={thread.id} className="list-row group">
                  <button
                    type="button"
                    onClick={() => void navigate(`/app/kb/${kb.id}/ask?thread=${thread.id}`)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <p className="truncate text-[13px] font-medium text-ink">{thread.title}</p>
                    {thread.preview && thread.preview !== thread.title && (
                      <p className="mono-meta truncate">{thread.preview}</p>
                    )}
                  </button>

                  <span className="mono-meta w-20 shrink-0 text-right">
                    {Math.floor(thread.messageCount / 2)} asked
                  </span>
                  <span className="mono-meta w-14 shrink-0 text-right">
                    {when(thread.lastMessageAt ?? thread.createdAt)}
                  </span>

                  <button
                    type="button"
                    onClick={() => void remove(thread.id)}
                    className="w-12 shrink-0 text-right text-[12px] text-ink-faint opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
                    aria-label={`delete ${thread.title}`}
                  >
                    delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}
