import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type {
  Citation,
  ConversationSummary,
  Document,
  Message,
  RetrievalMode,
} from '@trace/contracts';
import { api } from '../lib/api.js';
import { useAnswer } from '../lib/useAnswer.js';
import { AgentTimeline } from '../components/AgentTimeline.js';
import { CitationsPanel } from '../components/CitationsPanel.js';
import { Compare } from '../components/Compare.js';
import { DocumentReader } from '../components/DocumentReader.js';
import { Thread } from '../components/Thread.js';
import { VERA, VeraGreeting } from '../components/Vera.js';
import { Segmented } from '../components/ui.js';
import { useKb } from './KbLayout.js';

/** The reading room: the document on the left, the answer as marginalia. */
export function Ask(): React.ReactElement {
  const { kb, library } = useKb();
  const [params, setParams] = useSearchParams();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ConversationSummary[]>([]);
  const [history, setHistory] = useState<Message[]>([]);
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [mode, setMode] = useState<RetrievalMode | 'compare'>('agentic');
  const [citation, setCitation] = useState<Citation | null>(null);
  const [peeked, setPeeked] = useState<Citation | null>(null);
  const [activeMarker, setActiveMarker] = useState<number | null>(null);
  const [openDoc, setOpenDoc] = useState<Document | null>(null);
  /**
   * The document the next question is about. Set when one is opened from the
   * library, because "what kind of document is this?" names nothing a
   * retriever can match and would otherwise be answered from whatever in the
   * corpus happened to rank highest. Not set by a citation opening its own
   * source: there the reader followed the answer, so the conversation is
   * already about the right thing and narrowing it would be wrong.
   */
  const [scope, setScope] = useState<Document | null>(null);
  /** True while the two answer states on screen came from a compare run. */
  const [compared, setCompared] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [greeted, setGreeted] = useState(false);
  const [focused, setFocused] = useState(false);
  /** Width of the conversation column as a percentage. The reader takes the
   *  remainder when it is open, and nothing when it is not. */
  const [split, setSplit] = useState(62);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const primary = useAnswer();
  const secondary = useAnswer();

  // A conversation belongs to one knowledge base, so switching corpus switches
  // threads rather than carrying one across unrelated documents. The most
  // recently active thread is resumed, because the common case on returning is
  // continuing what you were asking, not starting again.
  useEffect(() => {
    let current = true;
    setConversationId(null);
    setHistory([]);
    setAsked(null);
    primary.reset();
    setCompared(false);
    secondary.reset();

    void api
      .conversations(kb.id)
      .then(async (list) => {
        if (!current) return;
        setThreads(list.conversations);
        // ?thread= makes a conversation a link, the way ?doc= makes a document
        // one: the overview and the thread list open a specific thread here,
        // and a reload lands back on it.
        const requestedThread = params.get('thread');
        // ?new=1 arrives from somewhere that just changed the corpus — an
        // upload, say. Resuming the last thread there drops you into a
        // conversation about something else entirely, which is the opposite of
        // what you came to ask about. An existing blank thread is reused so
        // the switcher does not fill with empties.
        const blank = list.conversations.find((entry) => entry.messageCount === 0);

        // Arriving with a document and no thread named means the library sent
        // you here to read that document. Resuming the last conversation puts
        // an unrelated thread beside it — answers about one document while a
        // different one is open in the reader, which reads as the thread
        // belonging to the document when it does not. A blank thread is the
        // honest starting point. An explicit ?thread= still wins, so a
        // citation that opens its own source keeps the conversation it came
        // from.
        const fresh =
          params.get('new') === '1' || (params.get('doc') !== null && requestedThread === null);

        const resumed = fresh
          ? blank
          : (list.conversations.find((entry) => entry.id === requestedThread) ??
            list.conversations[0]);
        if (resumed) {
          setConversationId(resumed.id);
          return;
        }
        const created = await api.createConversation(kb.id);
        if (!current) return;
        setThreads([
          {
            id: created.id,
            kbId: created.kbId,
            title: created.title,
            createdAt: created.createdAt,
            lastMessageAt: null,
            messageCount: 0,
            preview: null,
          },
        ]);
        setConversationId(created.id);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));

    return () => {
      current = false;
    };
    // primary and secondary are stable across renders; re-running on them
    // would restart the thread every time an answer streams a token. params is
    // read once on entry on purpose: changing the URL as you switch threads
    // should not re-run this and fight the switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kb.id]);

  // The open thread is written into the URL. A reload, a shared link and the
  // back button then all land on the conversation that was on screen — before
  // this, refreshing resumed "the most recent thread", which after opening a
  // document was a blank one, and the conversation looked deleted when it was
  // only unreachable.
  useEffect(() => {
    if (!conversationId) return;
    if (params.get('thread') === conversationId) return;
    const next = new URLSearchParams(params);
    next.set('thread', conversationId);
    // ?new= has been honoured by the time a thread exists; leaving it in the
    // URL would start another fresh thread on the next reload.
    next.delete('new');
    setParams(next, { replace: true });
    // params and setParams are stable per render from the router; re-running
    // on them would fight every other URL write on this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // The thread's stored turns. Every answer here was verified when it was
  // produced, so its citations still open the page they were resolved against.
  useEffect(() => {
    if (!conversationId) {
      setHistory([]);
      return;
    }
    let current = true;
    void api
      .history(conversationId)
      .then((loaded) => {
        if (current) setHistory(loaded.messages);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      current = false;
    };
  }, [conversationId]);

  // ?doc= makes a document a link: the library opens one here, and a reload or
  // a shared URL lands on the same page.
  const requested = params.get('doc');
  useEffect(() => {
    if (!requested) return;
    const found = library.documents.find((entry) => entry.id === requested);
    if (found) {
      setOpenDoc(found);
      setScope(found);
    }
  }, [requested, library.documents]);

  useEffect(() => {
    if (!citation || citation.external) return;
    const found = library.documents.find((entry) => entry.id === citation.documentId);
    if (found) setOpenDoc(found);
  }, [citation, library.documents]);

  const onDrag = useCallback((event: PointerEvent) => {
    if (!dragging.current || !bodyRef.current) return;
    const bounds = bodyRef.current.getBoundingClientRect();
    setSplit(Math.min(78, Math.max(34, ((event.clientX - bounds.left) / bounds.width) * 100)));
  }, []);

  useEffect(() => {
    const stop = (): void => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onDrag);
    window.addEventListener('pointerup', stop);
    return () => {
      window.removeEventListener('pointermove', onDrag);
      window.removeEventListener('pointerup', stop);
    };
  }, [onDrag]);

  const busy = primary.state.status === 'streaming' || secondary.state.status === 'streaming';

  /**
   * Starters named after documents that are actually in this corpus. A generic
   * prompt ("summarise everything") is the one kind of question this system
   * answers worst, because there is no span to cite for it.
   */
  const suggestions = useMemo(() => {
    const docs = library.documents;
    const pick = (test: (doc: Document) => boolean): Document | undefined => docs.find(test);
    const pdf = pick((doc) => doc.modality === 'pdf');
    const media = pick((doc) => doc.modality === 'audio' || doc.modality === 'video');
    const mail = pick((doc) => doc.modality === 'text');

    return [
      pdf ? `What does ${pdf.filename} say?` : null,
      media ? `What is said in ${media.filename}?` : null,
      mail ? `What was the last message about?` : null,
    ].filter((entry): entry is string => entry !== null);
  }, [library.documents]);

  const refreshThreads = (): void => {
    void api
      .conversations(kb.id)
      .then((list) => setThreads(list.conversations))
      .catch(() => undefined);
  };

  const startThread = async (): Promise<void> => {
    if (busy) return;
    try {
      // A blank thread already open is the new thread being asked for.
      // Creating another one each press is how a corpus ends up with sixty
      // empty conversations cluttering the switcher.
      const blank = threads.find(
        (entry) => entry.messageCount === 0 && entry.id !== conversationId,
      );
      if (blank) {
        primary.reset();
        setCompared(false);
        secondary.reset();
        setAsked(null);
        setCitation(null);
        setHistory([]);
        setConversationId(blank.id);
        return;
      }

      const created = await api.createConversation(kb.id);
      primary.reset();
      setCompared(false);
      secondary.reset();
      setAsked(null);
      setCitation(null);
      setHistory([]);
      setConversationId(created.id);
      refreshThreads();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const openThread = (id: string): void => {
    if (busy || id === conversationId) return;
    primary.reset();
    setCompared(false);
    secondary.reset();
    setAsked(null);
    setCitation(null);
    setConversationId(id);
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    void send(question);
  };

  /**
   * Asks a question, wherever it came from. The composer submits through here
   * and so do the suggested openers, which previously only dropped their text
   * into the box and left you to press Ask — a button that looks like a
   * question and answers nothing reads as broken.
   */
  const send = async (raw: string): Promise<void> => {
    const trimmed = raw.trim();
    if (!conversationId || !trimmed || busy) return;

    setGreeted(true);
    setCitation(null);
    setQuestion('');

    // The answer on screen becomes part of the thread above the new question.
    // Reloading it from the server rather than appending the local copy keeps
    // one source of truth for what was actually stored, including the
    // authoritative text that replaced any superseded tokens.
    if (primary.state.status === 'complete') {
      try {
        const loaded = await api.history(conversationId);
        setHistory(loaded.messages);
      } catch {
        // A failed refresh costs the transcript one turn, not the question.
      }
    }

    setAsked(trimmed);

    setCompared(mode === 'compare');

    if (mode === 'compare') {
      // Sequential, not parallel: the free tier meters requests per minute, and
      // two loops at once would spend the budget racing each other.
      await primary.ask(kb.id, conversationId, trimmed, 'agentic', scope?.id ?? null);
      await secondary.ask(kb.id, conversationId, trimmed, 'naive', scope?.id ?? null);
    } else {
      secondary.reset();
      await primary.ask(kb.id, conversationId, trimmed, mode, scope?.id ?? null);
    }

    // The first question names the thread, so the switcher is stale until this.
    refreshThreads();
  };

  // Hovering a marker or a card is the same gesture from two directions: it
  // lights the claim, lifts the card, and aims the reader at the page.
  const highlight = (marker: number | null): void => {
    setActiveMarker(marker);
    setPeeked(
      marker === null
        ? null
        : (primary.state.citations.find((entry) => entry.marker === marker) ?? null),
    );
  };

  // A chat is read from the foot: the turn you are waiting for is the newest
  // one, so the thread follows it instead of making you chase it down. It only
  // follows when you are already at the foot — someone who scrolled up to
  // re-read an earlier answer is not asking to be dragged back every time a
  // token lands.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 160) return;
    el.scrollTop = el.scrollHeight;
  }, [history, asked, primary.state.text, primary.state.status]);

  const shown = citation ?? peeked;
  const reading = Boolean(openDoc ?? (shown?.external ? shown : null));

  return (
    <>
      <div ref={bodyRef} className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col bg-paper">
          <div
            className="flex shrink-0 justify-center border-b border-rule px-4"
            style={{ height: 40, backgroundColor: 'var(--paper-sunk)' }}
          >
            <div
              className="flex w-full items-center gap-2"
              style={{ maxWidth: reading ? 820 : 1240 }}
            >
            <span className="eyebrow">thread</span>
            <select
              value={conversationId ?? ''}
              onChange={(event) => openThread(event.target.value)}
              disabled={busy || threads.length === 0}
              className="min-w-0 flex-1 truncate bg-transparent text-[12px] text-ink-muted focus:outline-none disabled:opacity-50"
            >
              {threads.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title}
                  {thread.messageCount > 0 ? ` · ${Math.floor(thread.messageCount / 2)} asked` : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void startThread()}
              disabled={busy}
              className="btn btn-ghost btn-sm shrink-0"
            >
              new thread
            </button>
            </div>
          </div>

          {mode === 'compare' ? (
            <Compare
              agentic={primary.state}
              naive={secondary.state}
              ran={compared}
              onSelectCitation={setCitation}
              selected={citation?.chunkId ?? null}
            />
          ) : (
            <div ref={threadRef} className="min-h-0 flex-1 overflow-y-auto scroll-slim">
              <div
                className="mx-auto grid w-full gap-8 px-8 py-7"
                style={{
                  maxWidth: reading ? 820 : 1240,
                  // The sources column only exists when there is something to
                  // put in it and room to put it: with the reader open the
                  // window is already split, and stacking beats squeezing.
                  gridTemplateColumns:
                    !reading && primary.state.citations.length > 0
                      ? 'minmax(0, 1fr) 300px'
                      : 'minmax(0, 1fr)',
                }}
              >
                <div className="min-w-0">
                {/* Stored turns and the one still streaming are the same
                    thread, in one component: the grounding strip, the typing
                    bubble and the sources all belong to the turn they describe
                    rather than to the page. */}
                <Thread
                  messages={history}
                  asked={asked}
                  live={primary.state}
                  onSelectCitation={setCitation}
                  activeMarker={activeMarker}
                  onActiveMarker={highlight}
                />

                {/* With the reader open the sources sit under the answer,
                    because the window is already carrying two columns. */}
                {reading && primary.state.citations.length > 0 && (
                  <div className="mt-8">
                    <CitationsPanel
                      citations={primary.state.citations}
                      onSelect={setCitation}
                      selected={citation?.chunkId ?? null}
                      activeMarker={activeMarker}
                      onActiveMarker={highlight}
                    />
                  </div>
                )}

                {primary.state.status === 'idle' && history.length === 0 && !greeted && (
                  <VeraGreeting
                    corpusName={kb.name}
                    documentCount={library.documents.length}
                    suggestions={suggestions}
                    onSuggest={(text) => void send(text)}
                    onDismiss={() => setGreeted(true)}
                  />
                )}

                {error && (
                  <p className="mt-4 text-[13px]" style={{ color: 'var(--vermillion)' }}>
                    {error}
                  </p>
                )}
                </div>

                {!reading && primary.state.citations.length > 0 && (
                  <aside className="min-w-0">
                    <p className="eyebrow pb-2">sources</p>
                    <CitationsPanel
                      citations={primary.state.citations}
                      onSelect={setCitation}
                      selected={citation?.chunkId ?? null}
                      activeMarker={activeMarker}
                      onActiveMarker={highlight}
                    />
                  </aside>
                )}
              </div>
            </div>
          )}

          <form onSubmit={submit} className="shrink-0 border-t border-rule px-4 py-3">
            <div
              className="mx-auto w-full rounded-lg border px-3 py-2.5"
              // Matches the column above it, so the room has one left edge.
              data-composer=""

              style={{
                maxWidth: reading ? 820 : 1240,
                borderColor: focused ? 'var(--vermillion)' : 'var(--rule)',
                backgroundColor: 'var(--surface)',
                transition: 'border-color var(--dur) var(--ease-out)',
              }}
            >
              <input
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder={
                  scope ? `Ask about ${scope.filename}` : `Ask ${VERA} about your documents`
                }
                disabled={busy || !conversationId}
                className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-50"
              />

              {/* The scope is always on screen while it applies. A search
                  quietly narrowed to one document, with nothing saying so, is
                  the same class of problem as a search quietly widened to the
                  web: the answer is not wrong, but the reader cannot tell what
                  it was drawn from. */}
              {scope && (
                <div className="mt-2 flex items-center gap-1.5">
                  <span className="chat-source" style={{ maxWidth: '100%' }}>
                    <span className="who">asking about {scope.filename}</span>
                    <button
                      type="button"
                      onClick={() => setScope(null)}
                      className="shrink-0 text-ink-faint hover:text-ink"
                      aria-label={`ask the whole corpus instead of ${scope.filename}`}
                    >
                      ×
                    </button>
                  </span>
                </div>
              )}

              <div className="mt-2.5 flex items-center gap-2">
                <Segmented
                  value={mode}
                  disabled={busy}
                  onChange={setMode}
                  options={[
                    { value: 'agentic' as const, label: 'agentic' },
                    { value: 'naive' as const, label: 'naive' },
                    { value: 'compare' as const, label: 'compare' },
                  ]}
                />

                <button
                  type="button"
                  onClick={() => setTraceOpen((value) => !value)}
                  className="btn btn-ghost btn-sm"
                  style={{ color: traceOpen ? 'var(--vermillion)' : undefined }}
                >
                  trace
                </button>

                <button
                  type="submit"
                  disabled={busy || !question.trim() || !conversationId}
                  className="btn btn-primary ml-auto"
                >
                  {busy ? 'Working…' : 'Ask'}
                </button>
              </div>
            </div>
          </form>
        </main>

        {/* The evidence arrives beside the conversation and leaves with it.
            Closing gives the thread the full width back, because a reader with
            nothing open should not be looking at an empty column. */}
        {reading && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={() => {
                dragging.current = true;
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
              }}
              className="w-px shrink-0 cursor-col-resize"
              style={{ backgroundColor: 'var(--rule)' }}
            />

            <section
              className="min-w-0 shrink-0 animate-lift"
              style={{ width: `${100 - split}%` }}
            >
              <DocumentReader
                document={openDoc}
                citation={shown}
                onClose={() => {
                  setOpenDoc(null);
                  setScope(null);
                  setCitation(null);
                  if (requested) {
                    params.delete('doc');
                    setParams(params, { replace: true });
                  }
                }}
              />
            </section>
          </>
        )}
      </div>

      {traceOpen && (
        <section className="h-64 shrink-0 overflow-hidden border-t border-rule bg-paper-sunk">
          <div className="flex items-center gap-3 px-4 py-1.5">
            <span className="eyebrow">agent trace</span>
            <button
              type="button"
              onClick={() => setTraceOpen(false)}
              className="ml-auto text-[12px] text-ink-faint hover:text-ink"
            >
              close
            </button>
          </div>
          <div className="h-[calc(100%-2rem)] overflow-y-auto scroll-slim">
            <AgentTimeline events={primary.state.events} />
          </div>
        </section>
      )}
    </>
  );
}
