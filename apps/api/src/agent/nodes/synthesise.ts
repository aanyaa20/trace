import { toError } from '../../errors.js';
import { evidenceFor, type AgentContext, type AgentState } from '../state.js';

const MAX_CHARS_PER_SOURCE = 1600;

export const ABSTENTION_TEXT =
  'The documents in this knowledge base do not contain enough evidence to answer that. Nothing here is close enough to the question for me to cite, so I would be guessing.';

/**
 * Distinct from an abstention on purpose. An abstention is a statement about
 * the corpus; this is a statement about the service. Collapsing the two would
 * tell a user their documents lack an answer when the truth is that the model
 * could not be reached.
 */
export const SYNTHESIS_FAILED_TEXT =
  'The answer could not be generated because the language model was unavailable. The retrieval steps above completed, so this is not a statement about your documents. Try again in a moment.';

const SYSTEM = `You answer strictly from the numbered sources you are given.

Rules, in order of importance:
1. Cite or do not claim. Every sentence containing a fact must end with a
   citation marker of the form [^n], where n is the number of the source that
   supports it. A sentence with no marker must contain no factual claim.
   Cite the ONE source that best supports the sentence. Add a second marker
   only when the sentence genuinely rests on two sources, and never use more
   than two. Do not attach every source you were given to every sentence: a
   marker is a pointer to where a reader should look, and a claim that points
   everywhere points nowhere.
2. Never use a source number you were not given.
3. If the sources do not support an answer, say so plainly in one or two
   sentences and cite nothing. Do not hedge, do not pad, and do not offer a
   partial answer built on a source that does not really support it. An honest
   "the sources do not cover this" is a correct answer, not a failure.
4. Sources marked EXTERNAL came from a web search and are not part of the
   user's corpus. You may use them, but say in the sentence that the claim
   comes from outside the corpus.
5. Write plainly. No preamble, no restating the question, no summary of what
   you are about to say.`;

function buildContext(state: AgentState): string {
  return evidenceFor(state)
    .map((chunk, index) => {
      const marker = index + 1;
      const locator: string[] = [chunk.filename];
      if (chunk.page !== null) locator.push(`page ${chunk.page}`);
      if (chunk.tsStart !== null) {
        locator.push(`${formatTimestamp(chunk.tsStart)}-${formatTimestamp(chunk.tsEnd ?? chunk.tsStart)}`);
      }
      if (chunk.external) locator.push('EXTERNAL');

      return `[${marker}] (${locator.join(', ')})\n${chunk.text.slice(0, MAX_CHARS_PER_SOURCE)}`;
    })
    .join('\n\n');
}

function formatTimestamp(seconds: number): string {
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Streams the answer. Tokens reach the client as they are produced, which is
 * why this node writes through ctx.onToken rather than returning a string.
 */
export async function synthesise(state: AgentState, ctx: AgentContext): Promise<AgentState> {
  const stage = ctx.bus.begin('synthesise', state.iteration);
  const evidence = evidenceFor(state);

  // The sufficiency gate is authoritative. Synthesising from evidence the gate
  // already judged insufficient would make the abstention path decorative, and
  // the trace would show a decision the answer contradicts.
  if (state.decision === 'abstain' || evidence.length === 0) {
    ctx.onToken(ABSTENTION_TEXT);
    stage.complete({ stage: 'synthesise', abstained: true, characters: ABSTENTION_TEXT.length });
    return { ...state, answer: ABSTENTION_TEXT, abstained: true };
  }

  const prompt = `Question: ${state.userQuery}

Sources:
${buildContext(state)}

Answer the question using only these sources, citing each factual sentence with
[^n]. If they do not support an answer, say so and cite nothing.`;

  try {
    let answer = '';
    for await (const token of ctx.llm.stream(prompt, {
      system: SYSTEM,
      temperature: 0.2,
      maxOutputTokens: 4000,
      signal: ctx.signal,
    })) {
      answer += token;
      ctx.onToken(token);
    }

    const trimmed = answer.trim();
    if (trimmed.length === 0) {
      ctx.onToken(ABSTENTION_TEXT);
      stage.complete({ stage: 'synthesise', abstained: true, characters: ABSTENTION_TEXT.length });
      return { ...state, answer: ABSTENTION_TEXT, abstained: true };
    }

    // An answer with no marker at all cited nothing, which by rule 1 means it
    // claimed nothing it could support. Citation resolution decides whether
    // that becomes an abstention.
    stage.complete({ stage: 'synthesise', abstained: false, characters: trimmed.length });
    return { ...state, answer: trimmed, abstained: false };
  } catch (cause) {
    const message = toError(cause).message;
    stage.fail(message);
    ctx.onToken(SYNTHESIS_FAILED_TEXT);
    return { ...state, answer: SYNTHESIS_FAILED_TEXT, abstained: true };
  }
}
