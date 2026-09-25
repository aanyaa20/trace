import { useEffect, useState } from 'react';
import { NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom';
import type { Connector, KnowledgeBase } from '@trace/contracts';
import { api } from '../lib/api.js';
import { useDocuments, type DocumentsState } from '../lib/useDocuments.js';

export interface KbContext {
  kb: KnowledgeBase;
  library: DocumentsState;
  connectors: Connector[];
  reloadConnectors: () => Promise<void>;
}

export function useKb(): KbContext {
  return useOutletContext<KbContext>();
}

/**
 * The modules of a knowledge base. They were a row of small grey words, which
 * is the least visible thing an interface can do with its own structure: a
 * reader could not tell how much of the system there was, let alone where they
 * were in it. A rail gives each one a mark, a name and a line of purpose, and
 * shows the whole set at once.
 */
interface Module {
  path: string;
  label: string;
  note: string;
  icon: React.ReactNode;
  /** The one a reader is most likely to want. Marked, not reordered. */
  primary?: boolean;
}

const MODULES: Module[] = [
  {
    path: '',
    label: 'Overview',
    note: 'what is in here',
    icon: (
      <>
        <rect x="2.5" y="2.5" width="5" height="5" rx="1" />
        <rect x="10.5" y="2.5" width="5" height="5" rx="1" />
        <rect x="2.5" y="10.5" width="5" height="5" rx="1" />
        <rect x="10.5" y="10.5" width="5" height="5" rx="1" />
      </>
    ),
  },
  {
    path: 'library',
    label: 'Library',
    note: 'the corpus',
    icon: (
      <>
        <rect x="2.5" y="2.5" width="13" height="13" rx="1.5" />
        <line x1="6" y1="2.5" x2="6" y2="15.5" />
      </>
    ),
  },
  {
    path: 'ask',
    label: 'Ask Vera',
    note: 'answers with citations',
    primary: true,
    icon: (
      <>
        <path d="M2.5 5.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7l-3.5 3v-3a1 1 0 0 1-1-1z" />
        <circle cx="7" cy="8" r="0.9" fill="currentColor" stroke="none" />
        <circle cx="11" cy="8" r="0.9" fill="currentColor" stroke="none" />
      </>
    ),
  },
  {
    path: 'threads',
    label: 'Threads',
    note: 'every conversation',
    icon: (
      <>
        <line x1="3" y1="5" x2="15" y2="5" />
        <line x1="3" y1="9" x2="12" y2="9" />
        <line x1="3" y1="13" x2="14" y2="13" />
      </>
    ),
  },
  {
    path: 'evaluation',
    label: 'Evaluation',
    note: 'agentic against naive',
    icon: (
      <>
        <line x1="3" y1="15" x2="15" y2="15" />
        <rect x="4" y="9" width="2.6" height="6" />
        <rect x="8" y="5.5" width="2.6" height="9.5" />
        <rect x="12" y="11" width="2.6" height="4" />
      </>
    ),
  },
  {
    path: 'mailboxes',
    label: 'Mailboxes',
    note: 'a corpus that arrives',
    icon: (
      <>
        <rect x="2.5" y="4" width="13" height="10" rx="1.5" />
        <path d="M2.8 5.2 9 9.8l6.2-4.6" />
      </>
    ),
  },
  {
    path: 'map',
    label: 'Map',
    note: 'the embedding space',
    icon: (
      <>
        <circle cx="5" cy="6" r="1.6" />
        <circle cx="12.5" cy="5" r="1.6" />
        <circle cx="9" cy="12" r="1.6" />
        <line x1="6.2" y1="6.8" x2="8" y2="10.6" />
        <line x1="11.6" y1="6.3" x2="9.9" y2="10.5" />
      </>
    ),
  },
];

const RAIL_KEY = 'trace:rail-collapsed';

/**
 * Everything under one knowledge base shares its documents and its connectors.
 * Fetching them here rather than per page means moving between the library and
 * the reading room does not re-request the corpus, and the ingestion stream
 * stays open across the move.
 */
export function KbLayout(): React.ReactElement {
  const { kbId } = useParams<{ kbId: string }>();
  const [kb, setKb] = useState<KnowledgeBase | null>(null);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [error, setError] = useState<string | null>(null);
  const library = useDocuments(kbId ?? null);
  // Remembered, because the rail is a preference about screen width rather
  // than about this corpus. Storage can throw in a private window, and a
  // sidebar is not worth a blank page.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(RAIL_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0');
    } catch {
      // A reader who blocks storage gets the default next time, and nothing else.
    }
  }, [collapsed]);

  useEffect(() => {
    if (!kbId) return;
    void api
      .knowledgeBases()
      .then(({ knowledgeBases }) => {
        const found = knowledgeBases.find((entry) => entry.id === kbId);
        if (!found) throw new Error('knowledge base not found');
        setKb(found);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [kbId]);

  const reloadConnectors = async (): Promise<void> => {
    if (!kbId) return;
    try {
      setConnectors((await api.connectors(kbId)).connectors);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    void reloadConnectors();
    // reloadConnectors closes over kbId only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kbId]);

  if (error) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center">
        <p className="text-[13px]" style={{ color: 'var(--vermillion)' }}>
          {error}
        </p>
      </main>
    );
  }

  if (!kb || !kbId) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center">
        <p className="eyebrow">loading corpus</p>
      </main>
    );
  }

  const context: KbContext = { kb, library, connectors, reloadConnectors };

  const counts: Record<string, number> = {
    library: library.documents.length,
    mailboxes: connectors.length,
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        className="flex shrink-0 flex-col border-r border-rule bg-paper-sunk"
        style={{ width: collapsed ? 52 : 196, transition: 'width var(--dur) var(--ease-out)' }}
      >
        <div className="flex items-center border-b border-rule px-3" style={{ height: 48 }}>
          {collapsed ? (
            <span
              className="mx-auto flex h-7 w-7 items-center justify-center rounded-md text-[12px] font-semibold"
              style={{ backgroundColor: 'var(--surface)', color: 'var(--ink)' }}
              title={kb.name}
            >
              {kb.name.slice(0, 1).toUpperCase()}
            </span>
          ) : (
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-semibold text-ink">{kb.name}</span>
              <span className="mono-meta block">
                {library.documents.length} document{library.documents.length === 1 ? '' : 's'}
              </span>
            </span>
          )}
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto scroll-slim px-2 py-3">
          {!collapsed && <p className="eyebrow px-2 pb-1.5">corpus</p>}
          <ul className="space-y-px">
            {MODULES.map((module) => (
              <li key={module.path}>
                <NavLink
                  to={module.path === '' ? `/app/kb/${kbId}` : `/app/kb/${kbId}/${module.path}`}
                  // The overview is the index route, so without this every
                  // entry would light up while sitting on it.
                  end={module.path === ''}
                  title={collapsed ? module.label : undefined}
                  className="relative flex items-center gap-2.5 rounded-md px-2"
                  data-collapsed={collapsed}
                  style={({ isActive }) => ({
                    height: collapsed ? 36 : 40,
                    justifyContent: collapsed ? 'center' : 'flex-start',
                    backgroundColor: isActive ? 'var(--surface-raised)' : 'transparent',
                    color: isActive ? 'var(--ink)' : 'var(--ink-muted)',
                    transition: 'background-color var(--dur) var(--ease-out)',
                  })}
                >
                  {({ isActive }) => (
                    <>
                      {/* The active mark is the same 2px vermillion tick the
                          reader puts beside a cited page. One vocabulary. */}
                      {isActive && (
                        <span
                          className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full"
                          style={{ backgroundColor: 'var(--vermillion)' }}
                        />
                      )}

                      <svg
                        width="17"
                        height="17"
                        viewBox="0 0 18 18"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                        className="shrink-0"
                        style={{
                          color: isActive
                            ? 'var(--vermillion)'
                            : module.primary
                              ? 'var(--ink-muted)'
                              : 'var(--ink-faint)',
                        }}
                      >
                        {module.icon}
                      </svg>

                      {!collapsed && (
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium leading-tight">
                            {module.label}
                          </span>
                          <span className="mono-meta block truncate leading-tight">
                            {module.note}
                          </span>
                        </span>
                      )}

                      {!collapsed && counts[module.path] !== undefined && (
                        <span className="mono-meta shrink-0">{counts[module.path]}</span>
                      )}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="border-t border-rule px-3 py-2.5 text-left text-[12px] text-ink-faint hover:text-ink"
          aria-label={collapsed ? 'expand the module rail' : 'collapse the module rail'}
        >
          {collapsed ? '»' : '« collapse'}
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {library.error && (
          <p
            className="px-4 py-1.5 text-[12px]"
            style={{ backgroundColor: 'var(--surface)', color: 'var(--vermillion)' }}
          >
            {library.error}
          </p>
        )}

        <Outlet context={context} />
      </div>
    </div>
  );
}
