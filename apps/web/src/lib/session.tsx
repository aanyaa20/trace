import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { User } from '@trace/contracts';
import { api } from './api.js';

type Phase = 'checking' | 'anonymous' | 'signed-in';

interface SessionValue {
  phase: Phase;
  user: User | null;
  signedIn: (user: User) => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * The session cookie is httpOnly, so the only way to know whether one exists is
 * to ask the server and let the request fail. That 401 on first load is the
 * price of not exposing the session to JavaScript.
 */
export function SessionProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [phase, setPhase] = useState<Phase>('checking');
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .me()
      .then((response) => {
        if (cancelled) return;
        setUser(response.user);
        setPhase('signed-in');
      })
      .catch(() => {
        if (!cancelled) setPhase('anonymous');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signedIn = useCallback((next: User) => {
    setUser(next);
    setPhase('signed-in');
  }, []);

  // The local session is cleared whether or not the request lands. Chaining the
  // state change off a promise that can reject once meant a failed call left
  // the user signed in with no feedback at all.
  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
    setPhase('anonymous');
  }, []);

  const value = useMemo<SessionValue>(
    () => ({ phase, user, signedIn, signOut }),
    [phase, user, signedIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession used outside SessionProvider');
  return value;
}
