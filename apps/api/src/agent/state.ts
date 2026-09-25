import type {
  Citation,
  ChunkGrade,
  QueryAnalysis,
  RetrievalMode,
  RetrievedChunk,
  SufficiencyDecision,
} from '@trace/contracts';
import type { LLMProvider } from '../llm/index.js';
import type { AgentEventBus } from './events.js';

/** One completed turn of the conversation this question belongs to. */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentState {
  readonly kbId: string;
  readonly userQuery: string;
  readonly mode: RetrievalMode;
  /**
   * Earlier turns, oldest first, so a follow-up can be resolved into a
   * standalone question. Read by the analyse node and by nothing else: prior
   * turns are never evidence. Letting synthesis see them would make an earlier
   * sentence citable as a source, and an answer grounded in a previous answer
   * is exactly the loop this system exists to prevent.
   */
  readonly history: ConversationTurn[];

  /**
   * The document the reader has open, when the question was asked about it.
   * Retrieval is confined to this document for the whole run — a deictic
   * question ("what is this?") carries no words a retriever can match, so
   * without the scope the corpus answers with whatever ranked highest.
   */
  readonly documentId: string | null;

  /** 1-based; incremented by the graph, never by a node. */
  iteration: number;
  analysis: QueryAnalysis | null;
  /** Queries the next retrieval will run. Seeded with the user's own words. */
  queries: string[];
  candidates: RetrievedChunk[];
  grades: ChunkGrade[];
  relevant: RetrievedChunk[];
  external: RetrievedChunk[];
  decision: SufficiencyDecision | null;
  /** Set once web fallback has run, so it is never attempted twice. */
  webSearched: boolean;

  answer: string;
  abstained: boolean;
  citations: Citation[];
}

export interface AgentContext {
  readonly bus: AgentEventBus;
  /** Generation. Used only by synthesis. */
  readonly llm: LLMProvider;
  /** Classification: query analysis and chunk grading. A separate model, so
   *  these do not spend the synthesis model's per-minute quota. */
  readonly fastLlm: LLMProvider;
  readonly signal: AbortSignal;
  /** Streams answer tokens as synthesis produces them. */
  readonly onToken: (text: string) => void;
}

export function initialState(input: {
  kbId: string;
  userQuery: string;
  mode: RetrievalMode;
  history?: ConversationTurn[];
  documentId?: string | null;
}): AgentState {
  return {
    kbId: input.kbId,
    userQuery: input.userQuery,
    mode: input.mode,
    history: input.history ?? [],
    documentId: input.documentId ?? null,
    iteration: 1,
    analysis: null,
    queries: [input.userQuery],
    candidates: [],
    grades: [],
    relevant: [],
    external: [],
    decision: null,
    webSearched: false,
    answer: '',
    abstained: false,
    citations: [],
  };
}

/** Everything the synthesiser may cite, corpus first so marker numbers stay
 *  stable when a web result is appended. */
export function evidenceFor(state: AgentState): RetrievedChunk[] {
  return [...state.relevant, ...state.external];
}
