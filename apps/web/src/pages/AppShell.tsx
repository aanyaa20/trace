import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../lib/session.js';
import { AccountMenu } from '../components/AccountMenu.js';
import { ThemeToggle } from '../components/ThemeToggle.js';

export function AppShell(): React.ReactElement {
  const { phase, user } = useSession();
  const location = useLocation();

  if (phase === 'checking') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-paper">
        <p className="eyebrow">restoring session</p>
      </main>
    );
  }

  // Where they were going is preserved, so signing in lands them there rather
  // than dumping them on the dashboard.
  if (phase === 'anonymous') {
    return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  }

  return (
    <div className="flex h-screen flex-col bg-paper text-ink">
      <header
        className="flex shrink-0 items-center gap-3 border-b border-rule px-4"
        style={{ height: 48, backgroundColor: 'var(--paper-sunk)' }}
      >
        {/* The wordmark goes to the front page, not to the dashboard. The
            dashboard already has a nav item of its own a few pixels to the
            right, so pointing both at it left the home page unreachable once
            you were signed in. */}
        <Link
          to="/"
          className="flex items-center gap-2 leading-none text-ink"
          aria-label="trace home page"
        >
          {/* The mark: a page with a rule through it, which is the whole
              product in one glyph — a document, and the line pointing at the
              part that was cited. */}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <rect
              x="2.5"
              y="1.5"
              width="11"
              height="13"
              rx="2"
              stroke="var(--ink)"
              strokeWidth="1.4"
            />
            <line
              x1="5"
              y1="9"
              x2="11"
              y2="9"
              stroke="var(--vermillion)"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
          <span className="font-display text-[16px] font-semibold tracking-[-0.02em]">trace</span>
        </Link>

        <span className="h-4 w-px" style={{ backgroundColor: 'var(--rule)' }} />

        <NavLink
          to="/app"
          end
          className="rounded-md px-2 py-1 text-[13px]"
          style={({ isActive }) => ({
            color: isActive ? 'var(--ink)' : 'var(--ink-faint)',
            backgroundColor: isActive ? 'var(--surface)' : 'transparent',
          })}
        >
          Dashboard
        </NavLink>

        <div className="ml-auto flex items-center gap-3">
          <span className="mono-meta hidden md:inline">{user?.email}</span>
          <ThemeToggle />
          <AccountMenu />
        </div>
      </header>

      <Outlet />
    </div>
  );
}
