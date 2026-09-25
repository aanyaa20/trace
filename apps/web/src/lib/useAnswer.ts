import { useCallback, useRef, useState } from 'react';
import type { AgentEvent, AgentTrace, Citation, RetrievalMode } from '@trace/contracts';
import { api } from './api.js';
import { streamChat } from './stream.js';

export interface AnswerState {
  status: 'idle' | 'streaming' | 'complete' | 'failed';
  /** Provisional while streaming; replaced by the authoritative text on done. */
  text: string;
  events: AgentEvent[];
  citations: Citation[];
  trace: AgentTrace | null;
  abstained: boolean;
  error: string | null;
}

const EMPTY: AnswerState = {
  status: 'idle',
  text: '',
  events: [],
  citations: [],
  trace: null,
  abstained: false,
  error: null,
};

/**
 * Drives one question to completion. Tokens are applied as they arrive so the
 * answer appears live, but the `done` frame is authoritative: an answer whose
 * citations all failed verification is replaced by an abstention, and the text
 * already on screen has to be corrected rather than trusted.
 */
export function useAnswer(): {
  state: AnswerState;
  ask: (
    kbId: string,
    conversationId: string,
    query: string,
    mode: RetrievalMode,
    documentId?: string | null,
  ) => Promise<void>;
  reset: () => void;
} {
  const [state, setState] = useState<AnswerState>(EMPTY);
  const close = useRef<(() => void) | null>(null);

  const reset = useCallback(() => {
    close.current?.();
    close.current = null;
    setState(EMPTY);
  }, []);

  const ask = useCallback(
    async (
      _kbId: string,
      conversationId: string,
      query: string,
      mode: RetrievalMode,
      documentId?: string | null,
    ) => {
      close.current?.();
      setState({ ...EMPTY, status: 'streaming' });

      let posted;
      try {
        posted = await api.postMessage(conversationId, query, mode, documentId);
      } catch (cause) {
        setState({
          ...EMPTY,
          status: 'failed',
          error: cause instanceof Error ? cause.message : String(cause),
        });
        return;
      }

      // Resolves when the stream ends, not when it opens. Callers that run two
      // modes one after another depend on this: the free tier meters requests
      // per minute, so two loops racing each other spend the budget twice as
      // fast and both start failing.
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };

        close.current = streamChat(posted.messageId, {
          onAgentEvent: (event) =>
            setState((previous) => ({ ...previous, events: [...previous.events, event] })),
          onToken: (text) =>
            setState((previous) => ({ ...previous, text: previous.text + text })),
          onCitations: (citations) => setState((previous) => ({ ...previous, citations })),
          onDone: (frame) => {
            setState((previous) => ({
              ...previous,
              status: 'complete',
              text: frame.answer,
              abstained: frame.abstained,
              trace: frame.trace,
            }));
            finish();
          },
          onError: (message) => {
            setState((previous) => ({ ...previous, status: 'failed', error: message }));
            finish();
          },
        });
      });
    },
    [],
  );

  return { state, ask, reset };
}
