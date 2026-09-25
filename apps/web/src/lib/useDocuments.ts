import { useCallback, useEffect, useState } from 'react';
import type { Document, IngestionEvent } from '@trace/contracts';
import { api } from './api.js';
import { streamIngestion } from './stream.js';

export interface DocumentsState {
  documents: Document[];
  /** True until the first read resolves. Without it an empty corpus and a
   *  corpus that has not loaded yet look identical, and the list flashes
   *  "nothing here" at someone who has hundreds of documents. */
  loading: boolean;
  progress: Record<string, IngestionEvent>;
  error: string | null;
  refresh: () => Promise<void>;
  setError: (message: string | null) => void;
}

/**
 * Documents are read once per knowledge base and kept live by the ingestion
 * stream. The state lives here rather than in the library list because the
 * reader needs the same rows: a citation carries a document id, but only the
 * document record knows how many pages there are to lay out.
 */
export function useDocuments(kbId: string | null): DocumentsState {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [progress, setProgress] = useState<Record<string, IngestionEvent>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!kbId) return;
    try {
      setDocuments((await api.documents(kbId)).documents);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [kbId]);

  useEffect(() => {
    setDocuments([]);
    setProgress({});
    setLoading(true);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!kbId) return;
    const close = streamIngestion(kbId, (event) => {
      setProgress((previous) => ({ ...previous, [event.documentId]: event }));
      // Terminal stages change the persisted row, so the list is re-read
      // rather than patched from the event.
      if (event.stage === 'completed' || event.stage === 'failed') void refresh();
    });
    return close;
  }, [kbId, refresh]);

  return { documents, loading, progress, error, refresh, setError };
}
