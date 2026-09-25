import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from './pages/AppShell.js';
import { Ask } from './pages/Ask.js';
import { Dashboard } from './pages/Dashboard.js';
import { Evaluation } from './pages/Evaluation.js';
import { Home } from './pages/Home.js';
import { KbLayout } from './pages/KbLayout.js';
import { Library } from './pages/Library.js';
import { Mailboxes } from './pages/Mailboxes.js';
import { MapPage } from './pages/MapPage.js';
import { NotFound } from './pages/NotFound.js';
import { Overview } from './pages/Overview.js';
import { SignIn } from './pages/SignIn.js';
import { Threads } from './pages/Threads.js';

/**
 * Real routes rather than one page with modes. The corpus, the reading room and
 * the connected mailboxes are different places to be, and a link to a document
 * or an answer should survive a reload and be shareable.
 */
export const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  { path: '/signin', element: <SignIn /> },
  {
    path: '/app',
    element: <AppShell />,
    children: [
      { index: true, element: <Dashboard /> },
      {
        path: 'kb/:kbId',
        element: <KbLayout />,
        children: [
          { index: true, element: <Overview /> },
          { path: 'library', element: <Library /> },
          { path: 'ask', element: <Ask /> },
          { path: 'threads', element: <Threads /> },
          { path: 'evaluation', element: <Evaluation /> },
          { path: 'mailboxes', element: <Mailboxes /> },
          { path: 'map', element: <MapPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
]);
