import { Link } from 'react-router-dom';

export function NotFound(): React.ReactElement {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-paper px-6">
      <p className="eyebrow">404</p>
      <h1 className="font-display text-[22px] font-medium text-ink" style={{ fontOpticalSizing: 'auto' }}>
        Nothing here.
      </h1>
      <Link to="/app" className="text-[13px] underline decoration-dotted underline-offset-2" style={{ color: 'var(--vermillion)' }}>
        back to the dashboard
      </Link>
    </main>
  );
}
