import { queryAnalysisSchema, type QueryAnalysis } from '@trace/contracts';
import { toError } from '../../errors.js';
import type { AgentContext, AgentState, ConversationTurn } from '../state.js';

const SYSTEM = `You prepare a search plan for a retrieval system over a private
document corpus. The corpus may contain PDFs, plain text, images, audio and
video. You never answer the question yourself.`;

const SHAPE = `{
  "intent": "one short sentence describing what the user actually wants",
  "modalityHints": ["pdf"],
  "rewrites": ["alternative phrasing 1", "alternative phrasing 2"],
  "reasoning": "one sentence on why these rewrites should retrieve better",
  "standaloneQuery": "the question with every reference to earlier turns resolved"
}`;

/** Turns kept for reference resolution. Two exchanges is what a pronoun or an
 *  ordinal ("the second one") reaches back across; more spends tokens on
 *  context that no longer constrains the question. */
const MAX_TURNS = 4;

/** Prior answers can be long. Only the part that establishes what a follow-up
 *  refers to is useful here, and it is at the start. */
const MAX_TURN_CHARS = 600;

function transcript(history: ConversationTurn[]): string {
  return history
    .slice(-MAX_TURNS)
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content.slice(0, MAX_TURN_CHARS)}`)
    .join('\n');
}

function prompt(query: string, history: ConversationTurn[]): string {
  const preamble =
    history.length === 0
      ? ''
      : `Earlier turns of this conversation, oldest first. They are context for
reading the question, not material to answer from:

${transcript(history)}

`;

  const standalone =
    history.length === 0
      ? `standaloneQuery: omit this field. There is no earlier turn to resolve
against.`
      : `standaloneQuery: rewrite the question so it stands on its own, with
every pronoun, ellipsis and ordinal replaced by the words it refers to — "what
about the second one" becomes the thing it names. A question that already
stands alone is repeated unchanged. Never answer it, and never add a fact the
user did not put there: this string is sent to a retriever, and inventing
detail retrieves the wrong documents.`;

  return `${preamble}Question: ${query}

Produce a search plan.

modalityHints: include only modalities the question explicitly points at, for
example "the photo" or "the diagram" implies image, "the recording" implies
audio or video, "the paper" implies pdf. A slide may be a presentation (text)
or a photographed slide (image), so for "slide" use both or neither. Use an empty array when the question implies nothing, which
is the common case. Never guess a modality just to fill the field.

rewrites: two or three alternative phrasings that would match the wording a
document is likely to use. Prefer domain vocabulary over the user's casual
phrasing. Do not include the original question.
- Keep every name, number, code, equation, filename, section or page number
  and quoted phrase from the question exactly as written. Never paraphrase or
  "correct" them: "TB-2048" stays "TB-2048", "section 3.2" stays "section 3.2".
- Make at least one rewrite a short keyword form (the key terms only, e.g.
  "RAG generator role"), and at least one that names the concept the answer
  would describe (e.g. "generation component produces the final answer").
- For a comparison, make one rewrite about each thing being compared, so both
  sides are retrieved.

intent: one short phrase naming the task — for example "definition",
"factual lookup", "summary", "comparison", "extraction", "list", "explanation",
"question generation", "source lookup" — followed by what is being asked.

${standalone}`;
}

/**
 * The first stage. A failure here is recoverable: retrieval still runs on the
 * user's original wording, which is exactly what naive mode does anyway.
 *
 * It is also the only stage that reads the conversation history. Resolving a
 * follow-up is a retrieval problem — the words have to reach the index — so it
 * belongs here rather than in synthesis, where prior turns would become
 * quotable and an ungrounded sentence could be recycled as a source.
 */
export async function analyse(state: AgentState, ctx: AgentContext): Promise<AgentState> {
  const stage = ctx.bus.begin('analyse', state.iteration);

  try {
    const analysis: QueryAnalysis = await ctx.fastLlm.generateStructured(
      prompt(state.userQuery, state.history),
      queryAnalysisSchema,
      SHAPE,
      {
        system: SYSTEM,
        temperature: 0.1,
        signal: ctx.signal,
        // Optional stage: on failure retrieval runs on the user's own words,
        // so a long rate-limit pause is not worth waiting out.
        maxRetries: 1,
        maxRetryDelayMs: 20_000,
      },
    );

    stage.complete({ stage: 'analyse', analysis });
    return {
      ...state,
      analysis,
      // The resolved question leads, because on a follow-up the user's own
      // words ("and the second one?") match nothing in the corpus. On a first
      // turn there is nothing to resolve and this is the original wording,
      // which is the only phrasing we know the user meant.
      queries: [searchQuery(state, analysis), ...analysis.rewrites],
    };
  } catch (cause) {
    stage.fail(toError(cause).message);
    return { ...state, analysis: null, queries: [state.userQuery] };
  }
}

/**
 * The phrasing retrieval should run on. Shared with the graph, so a retry
 * reformulates from the resolved question rather than dropping back to a
 * follow-up that no longer says what it is about.
 */
export function searchQuery(state: AgentState, analysis = state.analysis): string {
  const resolved = analysis?.standaloneQuery?.trim();
  return resolved && resolved.length > 0 ? resolved : state.userQuery;
}

/** Words that carry no retrieval signal on their own. */
const STOPWORDS = new Set(
  (
    'a an the of in on at to for from by with about into over under and or but not no is are was were be been ' +
    'being do does did doing have has had having what which who whom whose when where why how this that these ' +
    'those it its they them their there here i me my we our you your he she his her can could should would will ' +
    'shall may might must please tell explain describe give show say says said according document documents ' +
    'file files paper corpus mention mentioned role purpose'
  ).split(' '),
);

/**
 * The question reduced to its content terms, for a keyword-heavy retry.
 *
 * Deterministic, and conservative about what it keeps: anything containing a
 * digit, an uppercase letter after the first, a hyphen, a dot or a slash is
 * kept verbatim — "TB-2048", "3.2", "BERT", "2005.11401v4.pdf" — because those
 * are exactly the tokens a rewrite must never paraphrase. Only lowercase
 * function words are dropped.
 */
export function keywordQuery(text: string): string {
  const tokens = text.split(/\s+/).map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
  const kept = tokens.filter((token) => {
    if (token.length === 0) return false;
    if (/[\d\-./]/.test(token) || /\p{Lu}/u.test(token.slice(1))) return true;
    return !STOPWORDS.has(token.toLowerCase());
  });
  return kept.join(' ');
}
