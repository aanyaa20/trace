import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './router.js';
import { SessionProvider } from './lib/session.js';
import { applyTheme, storedTheme } from './lib/theme.js';
import './styles.css';

// Applied before the first render so a reload does not flash the other theme.
applyTheme(storedTheme());

const container = document.getElementById('root');
if (!container) throw new Error('root element is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>
  </StrictMode>,
);
