import { useState } from 'react';
import { applyTheme, storedTheme, type Theme } from '../lib/theme.js';

/**
 * The lights. Its own control rather than a line in the account menu, because
 * switching theme has nothing to do with who you are signed in as, and it is
 * reached often enough to deserve one press rather than two.
 */
export function ThemeToggle(): React.ReactElement {
  const [theme, setTheme] = useState<Theme>(() => storedTheme());
  const next: Theme = theme === 'light' ? 'dark' : 'light';

  return (
    <button
      type="button"
      onClick={() => {
        setTheme(next);
        applyTheme(next);
      }}
      className="icon-btn"
      aria-label={`switch to the ${next} theme`}
      title={`switch to the ${next} theme`}
    >
      {theme === 'light' ? (
        /* A moon: what pressing it gets you. */
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M13.4 9.9A5.8 5.8 0 0 1 6.1 2.6a5.8 5.8 0 1 0 7.3 7.3Z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M8 1.2v1.5M8 13.3v1.5M14.8 8h-1.5M2.7 8H1.2M12.8 3.2l-1 1M4.2 11.8l-1 1M12.8 12.8l-1-1M4.2 4.2l-1-1"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}
