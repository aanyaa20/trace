import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';

const DEMO = { email: 'demo@trace.local', password: 'trace-demo-password' };

/**
 * The specimen: what an answer looks like, printed on parchment against the
 * dark panel. It is the one saturated object on this screen because it is the
 * only thing here worth looking at — the form is a door, not a destination.
 */
function Specimen(): React.ReactElement {
  return (
    <figure
      className="rounded-md px-5 py-4"
      style={{ backgroundColor: 'var(--card-bg)', color: 'var(--card-ink)' }}
    >
      <p className="text-[15px] leading-[1.6]">
        Page boundaries are never crossed by chunks
        <span
          className="ml-px font-mono text-[11px] font-medium"
          style={{ position: 'relative', top: '-0.5em', color: 'var(--card-accent)' }}
        >
          1
        </span>
        , so every chunk keeps one page number
        <span
          className="ml-px font-mono text-[11px] font-medium"
          style={{ position: 'relative', top: '-0.5em', color: 'var(--card-accent)' }}
        >
          1
        </span>
        .
      </p>

      <figcaption
        className="mt-3 flex flex-wrap items-baseline gap-x-2 border-t pt-2.5 font-mono text-[11px]"
        style={{ borderColor: 'var(--card-rule)', color: 'var(--card-ink-muted)' }}
      >
        <span style={{ color: 'var(--card-accent)' }}>1</span>
        <span>handbook.pdf</span>
        <span style={{ color: 'var(--card-ink-faint)' }}>·</span>
        <span>p.2</span>
        <span style={{ color: 'var(--card-ink-faint)' }}>·</span>
        <span>ch 1204–1560</span>
      </figcaption>
    </figure>
  );
}

export function SignIn(): React.ReactElement {
  const { phase, signedIn } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // "Create an account" in the header menu lands here directly on the register
  // form rather than on a sign-in form the visitor then has to switch.
  const [mode, setMode] = useState<'login' | 'register'>(
    params.get('new') === '1' ? 'register' : 'login',
  );
  const [email, setEmail] = useState(DEMO.email);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);

  if (phase === 'signed-in') return <Navigate to="/app" replace />;

  const enter = async (
    credentials: { email: string; password: string },
    register: boolean,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = register
        ? await api.register(credentials.email, credentials.password)
        : await api.login(credentials.email, credentials.password);
      signedIn(response.user);
      void navigate('/app');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    void enter({ email, password }, mode === 'register');
  };

  return (
    <main className="grid min-h-screen bg-paper lg:grid-cols-[1fr_minmax(0,29rem)]">
      {/* The panel is ink in both themes. Two beiges side by side read as a
          fault rather than a split, and the parchment specimen needs a dark
          room to be printed in. */}
      <section
        className="relative hidden flex-col justify-between px-12 py-10 lg:flex"
        style={{
          backgroundColor: 'var(--auth-panel)',
          color: 'var(--auth-panel-ink)',
          borderRight: '1px solid var(--auth-panel-rule)',
        }}
      >
        <Link
          to="/"
          className="font-mono text-[11px] uppercase tracking-[0.13em] transition-colors"
          style={{ color: 'var(--auth-panel-muted)' }}
        >
          ← trace
        </Link>

        <div className="max-w-[34rem] py-10">
          <h2
            className="font-display text-[clamp(1.75rem,2.6vw,2.3rem)] font-semibold leading-[1.12] tracking-[-0.025em]"
            style={{ color: 'var(--auth-panel-ink)' }}
          >
            Every sentence points at the page it came from.
          </h2>

          <p
            className="mt-4 max-w-[46ch] text-[14.5px] leading-[1.65]"
            style={{ color: 'var(--auth-panel-muted)' }}
          >
            Ask a question about your own documents, recordings and scans. Each claim carries a
            number that opens the exact page, span or second behind it — and a claim that cannot be
            grounded is deleted before it reaches you.
          </p>

          <div className="mt-8 max-w-[26rem]">
            <Specimen />
          </div>

          <p
            className="mt-5 font-mono text-[11px] leading-relaxed"
            style={{ color: 'var(--auth-panel-muted)' }}
          >
            pdf · scanned pages · images · audio · video · mail
          </p>
        </div>

        <p className="font-mono text-[11px]" style={{ color: 'var(--auth-panel-muted)' }}>
          no GPU · no paid API · runs locally
        </p>
      </section>

      <section className="flex items-center justify-center px-6 py-14">
        <div className="w-full max-w-[22rem]">
          <Link to="/" className="eyebrow hover:text-ink lg:hidden">
            ← trace
          </Link>

          <form onSubmit={submit} className="animate-lift lg:mt-0">
            <h1 className="page-title mt-6 lg:mt-0" style={{ fontOpticalSizing: 'auto' }}>
              {mode === 'login' ? 'Sign in' : 'Create an account'}
            </h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">
              {mode === 'login'
                ? 'Answers from your own documents, with citations you can open.'
                : 'A new account starts with an empty corpus.'}
            </p>

            {/* The demo account is the path almost everyone takes on a first
                visit, so it is one press rather than a form to fill in and a
                password to be told somewhere else. */}
            {mode === 'login' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void enter(DEMO, false)}
                className="btn btn-primary mt-6 w-full"
              >
                {busy ? 'Working…' : 'Try the demo corpus'}
              </button>
            )}

            {mode === 'login' && (
              <p className="mono-meta mt-2 text-center">14 documents, already indexed</p>
            )}

            {mode === 'login' && (
              <div className="mt-7 flex items-center gap-3">
                <span className="h-px flex-1" style={{ backgroundColor: 'var(--rule)' }} />
                <span className="mono-meta">or with your account</span>
                <span className="h-px flex-1" style={{ backgroundColor: 'var(--rule)' }} />
              </div>
            )}

            <div className={mode === 'login' ? 'mt-5 space-y-3' : 'mt-6 space-y-3'}>
              <label className="block">
                <span className="eyebrow">email</span>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  className="field mt-1.5 w-full"
                />
              </label>

              <label className="block">
                <span className="flex items-baseline">
                  <span className="eyebrow">password</span>
                  <button
                    type="button"
                    onClick={() => setReveal((value) => !value)}
                    className="mono-meta ml-auto hover:text-ink"
                  >
                    {reveal ? 'hide' : 'show'}
                  </button>
                </span>
                <input
                  type={reveal ? 'text' : 'password'}
                  required
                  minLength={mode === 'register' ? 10 : 1}
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={mode === 'register' ? 'at least 10 characters' : '••••••••'}
                  className="field mt-1.5 w-full"
                />
              </label>
            </div>

            {error && (
              <p
                className="mt-3 border-l-2 pl-3 text-[13px]"
                style={{ borderColor: 'var(--vermillion)', color: 'var(--vermillion)' }}
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className={`btn mt-4 w-full ${mode === 'login' ? 'btn-secondary' : 'btn-primary'}`}
            >
              {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>

            <button
              type="button"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setError(null);
              }}
              className="mt-5 w-full text-[12px] text-ink-faint hover:text-ink"
            >
              {mode === 'login' ? 'Create an account instead' : 'Sign in instead'}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
