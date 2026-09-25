import type { AgentTrace, Citation, RetrievalMode } from '@trace/contracts';
import { env } from '../env.js';
import { llm, llmFast } from '../llm/index.js';
import { AgentEventBus } from './events.js';
import { citations } from './citations.js';
import { analyse, searchQuery } from './nodes/analyse.js';
import { classifySmallTalk, smallTalkReply } from './nodes/smalltalk.js';
import { grade } from './nodes/grade.js';
import { retrieve } from './nodes/retrieve.js';
import { sufficiency } from './nodes/sufficiency.js';
import { synthesise } from './nodes/synthesise.js';
import { webSearch } from './nodes/webSearch.js';
import {
  initialState,
  type AgentContext,
  type AgentState,
  type ConversationTurn,
} from './state.js';

export interface RunInput {
  kbId: string;
  query: string;
  mode: RetrievalMode;
  /**
   * Earlier turns of the same conversation, oldest first. Optional: the
   * evaluation harness asks one-off questions and passes nothing, which is
   * also what makes a scored run independent of the order its questions ran
   * in.
   */
  history?: ConversationTurn[];
  /** Confines retrieval to one document, for a question asked about it. */
  documentId?: string | null;
  signal: AbortSignal;
  onEvent: (event: Parameters<Parameters<AgentEventBus['subscribe']>[0]>[0]) => void;
  onToken: (text: string) => void;
}

export interface RunResult {
  answer: string;
  abstained: boolean;
  citations: Citation[];
  trace: AgentTrace;
}

/**
 * Rewrites the plan for another pass. Reusing the same queries would retrieve
 * the same chunks, so a retry that cannot rewrite is a retry worth skipping.
 */
function nextQueries(state: AgentState): string[] {
  const rewrites = state.analysis?.rewrites ?? [];
  const unused = rewrites.filter((rewrite) => !state.queries.includes(rewrite));
  return unused.length > 0 ? unused : [searchQuery(state), ...rewrites].slice(0, 3);
}

/**
 * Naive mode: retrieve once, cite the top chunks, synthesise. No analysis, no
 * grading, no sufficiency gate. It shares the synthesis prompt and the
 * citation resolver with agentic mode so the evaluation compares retrieval
 * strategies rather than two different prompts.
 *
 * It therefore ignores the conversation history too, since resolving a
 * follow-up happens in the analysis stage this mode does not run. That is the
 * honest baseline: single-pass retrieval on the words the user typed. Giving
 * it the resolved question would quietly move part of the agentic loop into
 * the control.
 */
async function runNaive(state: AgentState, ctx: AgentContext): Promise<AgentState> {
  const retrieved = await retrieve(state, ctx);
  const withEvidence: AgentState = {
    ...retrieved,
    relevant: retrieved.candidates.slice(0, env.RETRIEVAL_TOP_K),
  };
  const synthesised = await synthesise(withEvidence, ctx);
  return citations(synthesised, ctx);
}

async function runAgentic(start: AgentState, ctx: AgentContext): Promise<AgentState> {
  let state = await analyse(start, ctx);

  for (;;) {
    state = await retrieve(state, ctx);
    state = await grade(state, ctx);
    state = await sufficiency(state, ctx);

    if (state.decision === 'answer') break;

    if (state.decision === 'retry') {
      // The guard lives here, not in the nodes, so there is exactly one place
      // where the loop can fail to terminate.
      if (state.iteration >= env.AGENT_MAX_ITERATIONS) break;
      state = { ...state, iteration: state.iteration + 1, queries: nextQueries(state) };
      continue;
    }

    if (state.decision === 'web_fallback') {
      state = await webSearch(state, ctx);
      state = await sufficiency(state, ctx);
      break;
    }

    break;
  }

  const synthesised = await synthesise(state, ctx);
  return citations(synthesised, ctx);
}

export async function runAgent(input: RunInput): Promise<RunResult> {
  const bus = new AgentEventBus(input.mode);
  const unsubscribe = bus.subscribe(input.onEvent);

  const ctx: AgentContext = {
    bus,
    llm: llm(),
    fastLlm: llmFast(),
    signal: input.signal,
    onToken: input.onToken,
  };

  try {
    // Conversation is answered before retrieval, in both modes. It costs no
    // request, makes no claim about the corpus and therefore cites nothing;
    // the citation guarantee only has force over claims, and there are none
    // here. Anything that asks about the documents misses this and goes
    // through the loop.
    const smallTalk = classifySmallTalk(input.query);
    if (smallTalk) {
      const stage = bus.begin('converse', 1);
      const answer = smallTalkReply(smallTalk);
      stage.complete({ stage: 'converse', kind: smallTalk });
      input.onToken(answer);

      return {
        answer,
        abstained: false,
        citations: [],
        trace: bus.trace(1),
      };
    }

    const start = initialState({
      kbId: input.kbId,
      userQuery: input.query,
      mode: input.mode,
      ...(input.history ? { history: input.history } : {}),
      ...(input.documentId ? { documentId: input.documentId } : {}),
    });
    const final = input.mode === 'naive' ? await runNaive(start, ctx) : await runAgentic(start, ctx);

    return {
      answer: final.answer,
      abstained: final.abstained,
      citations: final.citations,
      trace: bus.trace(final.iteration),
    };
  } finally {
    unsubscribe();
  }
}
