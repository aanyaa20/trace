import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session.js';

/**
 * The account, behind one control in the corner where every site puts it.
 *
 * Signed out it is the two doors and nothing else. Signed in it names the
 * account before it offers to leave it — a sign-out sitting on its own, with
 * no account beside it, is how you end up signing out of the wrong one.
 */

/** Two letters off the local part, which is all an email reliably gives. */
function initialsOf(email: string): string {
  const local = email.split('@')[0] ?? email;
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

export function AccountMenu(): React.ReactElement {
  const { phase, user, signOut } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);

  // A menu that stays open when you look away from it is a menu you have to
  // dismiss twice. Escape returns focus to the control that opened it.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent): void => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const signedIn = phase === 'signed-in' && user !== null;
  const close = (): void => setOpen(false);

  return (
    <div ref={wrap} className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={signedIn ? `account: ${user.email}` : 'account'}
        className={`avatar${open ? ' is-open' : ''}`}
      >
        {signedIn ? (
          initialsOf(user.email)
        ) : (
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
            <circle cx="8" cy="5.4" r="2.6" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M2.9 13.6c.5-2.5 2.6-4 5.1-4s4.6 1.5 5.1 4"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        )}
      </button>

      {open && (
        <div role="menu" className="menu animate-lift">
          {signedIn ? (
            <>
              <div className="menu-head">
                <p className="truncate text-[13px] font-medium text-ink">{user.email}</p>
              </div>

              <Link to="/app" role="menuitem" className="menu-item" onClick={close}>
                Your knowledge bases
              </Link>

              <div className="menu-rule" />

              <button
                type="button"
                role="menuitem"
                className="menu-item is-danger"
                onClick={() => {
                  close();
                  void signOut().then(() => navigate('/'));
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link to="/signin" role="menuitem" className="menu-item" onClick={close}>
                Sign in
              </Link>

              <Link
                to="/signin?new=1"
                role="menuitem"
                className="menu-item"
                onClick={close}
              >
                Create an account
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}
