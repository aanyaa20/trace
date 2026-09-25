import { useCallback, useEffect, useState } from 'react';
import type { Connector } from '@trace/contracts';
import { api } from '../lib/api.js';

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

const STATUS_COLOR: Record<Connector['status'], string> = {
  idle: 'var(--moss)',
  syncing: 'var(--ochre)',
  failed: 'var(--vermillion)',
};

/**
 * Connecting a mailbox over IMAP with an app password rather than the Gmail
 * API. The API's Gmail scopes are restricted, which means an unverified app
 * hands back refresh tokens that expire in seven days — unusable for something
 * that syncs on a timer — and verification requires an annual security
 * assessment that costs real money. An app password has neither problem.
 */
export function MailboxPanel({
  kbId,
  onImported,
  onConnectors,
}: {
  kbId: string;
  onImported: () => void;
  /** Reported upward so the library can name each mailbox's shelf. */
  onConnectors?: (connectors: Connector[]) => void;
}): React.ReactElement {
  const [list, setList] = useState<Connector[]>([]);
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [email, setEmail] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [host, setHost] = useState('imap.gmail.com');
  const [mailbox, setMailbox] = useState('INBOX');
  const [sinceDays, setSinceDays] = useState(90);
  const [includeAttachments, setIncludeAttachments] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { connectors } = await api.connectors(kbId);
      setList(connectors);
      onConnectors?.(connectors);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [kbId, onConnectors]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A sync runs in a worker, so its result arrives by polling the row rather
  // than in the response. Only while something is actually in flight.
  useEffect(() => {
    if (!list.some((entry) => entry.status === 'syncing')) return;
    const timer = window.setInterval(() => {
      void refresh().then(onImported);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [list, refresh, onImported]);

  const connect = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createConnector(kbId, {
        kind: 'imap',
        email,
        appPassword,
        host,
        port: 993,
        mailbox,
        sinceDays,
        includeAttachments,
      });
      setAppPassword('');
      setOpen(false);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-5">
      <div className="flex items-center gap-3">
        <h3 className="mono-meta uppercase tracking-[0.14em]">mailboxes</h3>

        {/* A bordered control, not a text link. As faint text beside a label it
            read as part of the heading and was invisible as an action. */}
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="rounded-sm border px-2.5 py-1 text-xs transition-colors"
          style={
            open
              ? { borderColor: 'var(--vermillion)', color: 'var(--vermillion)' }
              : { borderColor: 'var(--rule)', color: 'var(--ink)' }
          }
        >
          {open ? 'cancel' : '+ connect a mailbox'}
        </button>

        {list.length === 0 && !open && (
          <span className="mono-meta">keep a gmail inbox in this corpus</span>
        )}
      </div>

      {list.length > 0 && (
        <ul className="mt-2 space-y-px">
          {list.map((connector) => (
            <li key={connector.id} className="group relative border-b border-rule px-3 py-2.5 last:border-b-0">
              <span
                className="absolute inset-y-0 left-0 w-[2px]"
                style={{ backgroundColor: STATUS_COLOR[connector.status] }}
              />

              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{connector.label}</span>

                <span className="mono-meta shrink-0" style={{ color: STATUS_COLOR[connector.status] }}>
                  {connector.status}
                </span>

                <button
                  type="button"
                  onClick={() => {
                    void api.syncConnector(connector.id).then(refresh);
                  }}
                  className="shrink-0 text-xs text-ink-faint transition-colors hover:text-ink"
                >
                  sync now
                </button>

                <button
                  type="button"
                  onClick={() => {
                    void api.deleteConnector(connector.id).then(refresh);
                  }}
                  className="shrink-0 text-xs text-ink-faint opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
                  aria-label={`disconnect ${connector.label}`}
                >
                  disconnect
                </button>
              </div>

              <p className="mono-meta mt-0.5">
                {connector.mailbox} · {connector.messagesImported} messages · synced{' '}
                {ago(connector.lastSyncedAt)}
                {connector.includeAttachments ? ' · attachments on' : ''}
              </p>

              {connector.error && (
                <p className="mono-meta mt-1 break-words" style={{ color: 'var(--vermillion)' }}>
                  {connector.error}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {open && (
        <form onSubmit={connect} className="mt-2 rounded-sm border border-rule bg-paper-sunk p-4 animate-lift">
          <p className="text-sm leading-relaxed text-ink-muted">
            Gmail needs an <strong className="font-medium text-ink">app password</strong>, not your
            account password. Turn on 2-Step Verification, then create one at{' '}
            <a
              href="https://myaccount.google.com/apppasswords"
              target="_blank"
              rel="noreferrer noopener"
              className="underline decoration-dotted underline-offset-2"
              style={{ color: 'var(--vermillion)' }}
            >
              myaccount.google.com/apppasswords
            </a>
            . It is stored encrypted and never sent back to this page.
          </p>

          <div className="mt-3 space-y-px">
            <input
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@gmail.com"
              className="w-full rounded-t-sm border border-rule bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-ink-faint focus:outline-none"
            />
            <input
              type="password"
              required
              value={appPassword}
              onChange={(event) => setAppPassword(event.target.value)}
              placeholder="app password (16 characters)"
              className="w-full rounded-b-sm border border-rule bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-ink-faint focus:outline-none"
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={includeAttachments}
                onChange={(event) => setIncludeAttachments(event.target.checked)}
                className="accent-[var(--vermillion)]"
              />
              import attachments
            </label>

            <label className="flex items-center gap-2 text-xs text-ink-muted">
              first import reaches back
              <input
                type="number"
                min={1}
                max={3650}
                value={sinceDays}
                onChange={(event) => setSinceDays(Number(event.target.value))}
                className="w-16 rounded-sm border border-rule bg-surface px-2 py-1 text-[12px] text-ink focus:border-ink-faint focus:outline-none"
              />
              days
            </label>

            <button
              type="button"
              onClick={() => setAdvanced((value) => !value)}
              className="text-xs text-ink-faint transition-colors hover:text-ink"
            >
              {advanced ? 'hide server' : 'server settings'}
            </button>
          </div>

          {advanced && (
            <div className="mt-3 flex gap-1">
              <input
                value={host}
                onChange={(event) => setHost(event.target.value)}
                placeholder="imap host"
                className="min-w-0 flex-1 rounded-sm border border-rule bg-surface px-2.5 py-1.5 text-[13px] text-ink focus:border-ink-faint focus:outline-none"
              />
              <input
                value={mailbox}
                onChange={(event) => setMailbox(event.target.value)}
                placeholder="mailbox"
                className="w-40 rounded-sm border border-rule bg-surface px-2.5 py-1.5 text-[13px] text-ink focus:border-ink-faint focus:outline-none"
              />
            </div>
          )}

          {error && (
            <p
              className="mt-3 border-l-2 pl-3 text-xs leading-relaxed"
              style={{ borderColor: 'var(--vermillion)', color: 'var(--vermillion)' }}
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !email || !appPassword}
            className="mt-4 rounded-sm px-3 py-1.5 text-[13px] font-medium disabled:opacity-40"
            style={{ backgroundColor: 'var(--ink)', color: 'var(--paper)' }}
          >
            {busy ? 'connecting' : 'connect'}
          </button>
        </form>
      )}
    </section>
  );
}
