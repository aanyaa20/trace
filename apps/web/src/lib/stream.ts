import type { AgentEvent, ChatStreamFrame, Citation, IngestionEvent } from '@trace/contracts';
import { API_URL } from './api.js';

export interface ChatStreamHandlers {
  onAgentEvent: (event: AgentEvent) => void;
  onToken: (text: string) => void;
  onCitations: (citations: Citation[]) => void;
  onDone: (frame: Extract<ChatStreamFrame, { type: 'done' }>) => void;
  onError: (message: string) => void;
}

/**
 * EventSource carries cookies on same-site requests and honours
 * withCredentials cross-origin, which is what lets the httpOnly session
 * authenticate a stream the browser opens on its own.
 */
export function streamChat(messageId: string, handlers: ChatStreamHandlers): () => void {
  const source = new EventSource(`${API_URL}/chat/stream/${messageId}`, {
    withCredentials: true,
  });

  const parse = <T>(event: MessageEvent): T | null => {
    try {
      return JSON.parse(event.data as string) as T;
    } catch {
      handlers.onError('received a malformed frame from the server');
      return null;
    }
  };

  source.addEventListener('agent', (event) => {
    const frame = parse<{ event: AgentEvent }>(event as MessageEvent);
    if (frame) handlers.onAgentEvent(frame.event);
  });

  source.addEventListener('token', (event) => {
    const frame = parse<{ text: string }>(event as MessageEvent);
    if (frame) handlers.onToken(frame.text);
  });

  source.addEventListener('citations', (event) => {
    const frame = parse<{ citations: Citation[] }>(event as MessageEvent);
    if (frame) handlers.onCitations(frame.citations);
  });

  source.addEventListener('done', (event) => {
    const frame = parse<Extract<ChatStreamFrame, { type: 'done' }>>(event as MessageEvent);
    if (frame) handlers.onDone(frame);
    source.close();
  });

  source.addEventListener('error', (event) => {
    const frame = parse<{ message?: string }>(event as MessageEvent);
    // A transport error arrives with no data; only a server error frame has a
    // message worth showing.
    if (frame?.message) {
      handlers.onError(frame.message);
      source.close();
    }
  });

  // EventSource reconnects forever by default. The stream runs exactly once,
  // so a drop after completion must not restart the agent.
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) return;
    source.close();
    handlers.onError('the answer stream was interrupted');
  };

  return () => source.close();
}

export function streamIngestion(
  kbId: string,
  onEvent: (event: IngestionEvent) => void,
): () => void {
  const source = new EventSource(`${API_URL}/events/ingestion/${kbId}`, {
    withCredentials: true,
  });

  source.addEventListener('ingestion', (event) => {
    try {
      onEvent(JSON.parse((event as MessageEvent).data as string) as IngestionEvent);
    } catch {
      // A dropped progress frame is not worth surfacing: document status is
      // persisted and the list refresh will show the truth.
    }
  });

  return () => source.close();
}
