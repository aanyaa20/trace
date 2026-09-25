import type {
  AuthResponse,
  Connector,
  ConnectorList,
  Conversation,
  ConversationList,
  Document,
  DocumentList,
  EvalResultList,
  EvalRunList,
  EmbeddingMap,
  KnowledgeBase,
  KnowledgeBaseList,
  Message,
  PostMessageResponse,
  ResolvedCitation,
  CreateConnectorRequest,
  RetrievalMode,
  UploadAccepted,
} from '@trace/contracts';

export const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8080';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// The session is an httpOnly cookie, so every call must opt into credentials;
// JavaScript cannot attach it manually.
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    ...init,
    headers:
      init.body instanceof FormData
        ? (init.headers ?? {})
        : { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { code?: string; message?: string }
      | null;
    throw new ApiError(
      response.status,
      body?.code ?? 'unknown',
      body?.message ?? `${init.method ?? 'GET'} ${path} failed with ${response.status}`,
    );
  }

  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export const api = {
  register: (email: string, password: string) =>
    request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  login: (email: string, password: string) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  me: () => request<AuthResponse>('/auth/me'),

  knowledgeBases: () => request<KnowledgeBaseList>('/kb'),

  createKnowledgeBase: (name: string, description?: string) =>
    request<KnowledgeBase>('/kb', {
      method: 'POST',
      body: JSON.stringify({ name, ...(description ? { description } : {}) }),
    }),

  deleteKnowledgeBase: (id: string) => request<void>(`/kb/${id}`, { method: 'DELETE' }),

  documents: (kbId: string) => request<DocumentList>(`/kb/${kbId}/documents`),

  upload: (kbId: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append('file', file);
    return request<UploadAccepted>(`/kb/${kbId}/documents`, { method: 'POST', body: form });
  },

  ingestUrl: (kbId: string, url: string) =>
    request<UploadAccepted>(`/kb/${kbId}/urls`, {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  deleteDocument: (id: string) => request<void>(`/documents/${id}`, { method: 'DELETE' }),

  connectors: (kbId: string) => request<ConnectorList>(`/kb/${kbId}/connectors`),

  createConnector: (kbId: string, input: CreateConnectorRequest) =>
    request<Connector>(`/kb/${kbId}/connectors`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  syncConnector: (id: string) =>
    request<Connector>(`/connectors/${id}/sync`, { method: 'POST' }),

  deleteConnector: (id: string) => request<void>(`/connectors/${id}`, { method: 'DELETE' }),

  conversations: (kbId: string) => request<ConversationList>(`/kb/${kbId}/conversations`),

  createConversation: (kbId: string, title?: string) =>
    request<Conversation>(`/kb/${kbId}/conversations`, {
      method: 'POST',
      body: JSON.stringify(title ? { title } : {}),
    }),

  deleteConversation: (conversationId: string) =>
    request<void>(`/chat/${conversationId}`, { method: 'DELETE' }),

  postMessage: (
    conversationId: string,
    query: string,
    mode: RetrievalMode,
    /** Confines retrieval to the document open in the reader. */
    documentId?: string | null,
  ) =>
    request<PostMessageResponse>(`/chat/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ query, mode, ...(documentId ? { documentId } : {}) }),
    }),

  history: (conversationId: string) =>
    request<{ messages: Message[] }>(`/chat/${conversationId}/messages`),

  evalRuns: (kbId: string) => request<EvalRunList>(`/kb/${kbId}/eval/runs`),

  evalResults: (runId: string) => request<EvalResultList>(`/eval/runs/${runId}/results`),

  resolveCitation: (chunkId: string) =>
    request<ResolvedCitation>(`/citations/${chunkId}/resolve`),

  embeddingMap: (kbId: string, query?: string) =>
    request<EmbeddingMap>(
      `/kb/${kbId}/embedding-map${query ? `?query=${encodeURIComponent(query)}` : ''}`,
    ),

  /**
   * The bytes of a text document, as text. A .txt has no rendered surface to
   * show — no pages, no player, no image — so the words themselves are the
   * surface, and without this the reading pane is simply blank.
   */
  documentText: async (documentId: string): Promise<string> => {
    const response = await fetch(`${API_URL}/documents/${documentId}/preview`, {
      credentials: 'include',
    });
    if (!response.ok) {
      throw new ApiError(response.status, 'preview_failed', `could not read document text`);
    }
    return response.text();
  },

  previewUrl: (documentId: string, page?: number) =>
    `${API_URL}/documents/${documentId}/preview${page ? `?page=${page}` : ''}`,
};

export type { Document, KnowledgeBase, Message };
