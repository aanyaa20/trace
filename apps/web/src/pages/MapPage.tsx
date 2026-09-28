import { useState } from 'react';
import { EmbeddingMap } from '../components/EmbeddingMap.js';
import { useKb } from './KbLayout.js';

export function MapPage(): React.ReactElement {
  const { kb } = useKb();
  const [query, setQuery] = useState('');
  const [projected, setProjected] = useState<string | null>(null);

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-paper">
      <div className="shrink-0 border-b border-rule px-6 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0">
            <p className="eyebrow">embedding map</p>
            <p className="mono-meta mt-0.5">
              every chunk projected to three PCA components, coloured by modality
            </p>
          </div>

          <form
            className="ml-auto flex min-w-0 gap-1 max-md:w-full"
            onSubmit={(event) => {
              event.preventDefault();
              setProjected(query.trim() || null);
            }}
          >
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="project a query into the same basis"
              className="w-72 min-w-0 max-md:flex-1 rounded-sm border border-rule bg-surface px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-ink-faint focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-sm border border-rule px-2.5 py-1.5 text-[13px] text-ink-muted hover:text-ink"
            >
              plot
            </button>
          </form>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <EmbeddingMap kbId={kb.id} query={projected} />
      </div>
    </main>
  );
}
