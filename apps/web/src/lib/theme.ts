export type Theme = 'light' | 'dark';

const KEY = 'trace-theme';

/**
 * Applied to the document element rather than held in React state alone, so the
 * first paint after a reload is already the right theme.
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // A private window can refuse storage. The theme still applies for this
    // session; only the memory of it is lost.
  }
}

/**
 * Dark is the default, and it is a choice rather than a fallback: this is a
 * reading room, and a rendered page or a parchment source card is a lit object
 * — it reads as printed material only when the room around it is not also
 * white. The OS preference is deliberately not consulted, because a light
 * desktop is not a request for this particular page to be light. Anyone who
 * wants light presses the toggle, and that choice is remembered.
 */
export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    if (value === 'light' || value === 'dark') return value;
  } catch {
    // ignored, see above
  }
  return 'dark';
}
