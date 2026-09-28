import { env } from '../../env.js';
import { toError } from '../../errors.js';
import { searchQuery } from './analyse.js';
import { focusWindow } from './grade.js';
import { evidenceFor, type AgentContext, type AgentState } from '../state.js';

const MAX_CHARS_PER_SOURCE = 1600;

/**
 * The same distinction for the grader. Passages were found, but the model that
 * judges them could not be reached (on a free tier, usually a per-minute
 * limit), so nothing was allowed through. Refusing is still right — ungraded
 * passages are not evidence — but saying the documents lack an answer would
 * be false.
 */
export const GRADING_FAILED_TEXT =
  "Sorry, I couldn't check the passages I found — the AI service is busy right now (its per-minute limit was reached). This is not a statement about your documents. Please ask again in about a minute.";

/**
 * An abstention decided while the LLM grader was unavailable the whole run.
 * The local reranker judged alone, and it scores tables, charts and diagram
 * descriptions near zero however well they answer; "your documents do not
 * contain this" would then be a claim nobody checked.
 */
export const LIMITED_CHECK_TEXT =
  "I couldn't confirm an answer, but this may not be the documents' fault: the AI service's usage limit was reached, so a smaller local model judged the passages on its own and it cannot read tables or diagrams well. Please ask again later.";

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

const SYSTEM = `You answer questions about the user's own documents, strictly
from the numbered sources you are given.

Rules, in order of importance:
1. Cite or do not claim. Every sentence containing a fact must end with a
   citation marker of the form [^n], where n is the number of the source that
   supports it. A sentence with no marker must contain no factual claim.
   Cite the ONE source that best supports the sentence. Add a second marker
   only when the sentence genuinely rests on two sources, and never use more
   than two. Do not attach every source you were given to every sentence: a
   marker is a pointer to where a reader should look, and a claim that points
   everywhere points nowhere.
2. Never use a source number you were not given. Never invent a page number,
   timestamp, filename, author, date or figure. The sources' labels are the
   only locations that exist.
3. If the sources do not support an answer, say so plainly in one or two
   sentences and cite nothing. Do not hedge, do not pad, and do not offer a
   partial answer built on a source that does not really support it. An honest
   "the sources do not cover this" is a correct answer, not a failure.
4. A missing detail is not a missing topic. When the question asks for a
   specific detail — a date, a name, a number, a price, a CEO, an author —
   that the sources do not state, say explicitly that the documents do not
   provide it, even if they discuss the subject at length. Never guess one,
   and never supply it from memory. What the sources do say about it is
   still a claim: cite it ("The image shows a robot beside books and a
   laptop[^1]; the documents do not say what it represents.").
5. When sources disagree, say that they disagree and cite each side. Never
   silently merge conflicting claims into one.
6. Do not add facts from your own knowledge. If the user explicitly asks for
   something beyond the documents, say that it is outside the provided
   material; if you then add general background, put it in its own sentence
   that begins "Outside your documents," and cite nothing.
7. Sources marked EXTERNAL came from a web search and are not part of the
   user's corpus. You may use them, but say in the sentence that the claim
   comes from outside the corpus.
8. Follow the requested form — simpler wording ("like I'm 10"), a list, a
   table, a comparison, questions or MCQs, a summary — without changing what
   the sources say. For a comparison, cover each side from its own sources.
   Questions or MCQs you write must be answerable from the sources, and each
   one's answer must be cited.
9. Write plainly. No preamble, no restating the question, no summary of what
   you are about to say.
10. Some sources are a CHART or TABLE read from an image, labelled with its
   type and title. Their rows are the printed values: quote them exactly, with
   the unit. When you use one, name it in the sentence ("the AI in Education
   Market Size chart shows…") so the reader knows the figure came from a
   chart and not from a paragraph. If a source says its values were estimated
   from the axis, say the figure is approximate. A CHART or TABLE source is
   never "the text" or "the written information", even though its rows are
   also given as sentences: those sentences were generated from the chart.
   If the question compares a chart or table with the written text and no
   written-text source covers it, say that the written text in the sources
   does not state these figures, rather than presenting the chart twice.
11. You may do arithmetic on cited figures — a difference, a total, a
   percentage change, which value is highest — when the question asks for it.
   Show the calculation with the figures it uses ("28.9 − 12.1 = 16.8") and
   cite the source of those figures. Never compute from a figure no source
   states.`;

function buildContext(state: AgentState, question: string): string {
  return evidenceFor(state)
    .map((chunk, index) => {
      const marker = index + 1;
      const locator: string[] = [chunk.filename];
      if (chunk.page !== null) {
        locator.push(`${/\.pptx?$/i.test(chunk.filename) ? 'slide' : 'page'} ${chunk.page}`);
      }
      const region = chunk.visual;
      if (region && region.type !== 'text') {
        // What the source is, before what it says: a model told "CHART" cites
        // it as a chart; told nothing, it presents the row as prose.
        locator.push(
          `${region.type.toUpperCase()}${region.title ? ` "${region.title}"` : ''}${
            region.origin === 'vision' ? ', read by a vision model' : ''
          }`,
        );
      } else if (chunk.section) {
        locator.push(`section "${chunk.section}"`);
      }
      if (chunk.tsStart !== null) {
        locator.push(`${formatTimestamp(chunk.tsStart)}-${formatTimestamp(chunk.tsEnd ?? chunk.tsStart)}`);
      }
      if (chunk.external) locator.push('EXTERNAL');

      return `[${marker}] (${locator.join(', ')})\n${focusWindow(chunk.text, question, MAX_CHARS_PER_SOURCE)}`;
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
/**
 * The evidence synthesis may read: the best SYNTHESIS_MAX_SOURCES corpus
 * passages, plus any external results. Applied to the state itself, not just
 * to the prompt, because the citation resolver numbers sources from the same
 * list — trimming only the prompt would point marker [3] at a different
 * passage than the model read as source 3.
 */
export function capEvidence(state: AgentState, max = env.SYNTHESIS_MAX_SOURCES): AgentState {
  if (state.relevant.length <= max) return state;
  const best = [...state.relevant].sort((a, b) => b.score - a.score).slice(0, max);
  return { ...state, relevant: best };
}

/** The question as synthesis should read it, with the user's own words kept
 *  alongside when a follow-up was resolved, since those carry the requested
 *  form ("like I'm 10", "as a table"). */
function questionFor(state: AgentState): string {
  const resolved = searchQuery(state);
  return resolved === state.userQuery
    ? state.userQuery
    : `${resolved}\n(The user's own words, in context of the conversation: "${state.userQuery}")`;
}

export async function synthesise(input: AgentState, ctx: AgentContext): Promise<AgentState> {
  const stage = ctx.bus.begin('synthesise', input.iteration);
  const state = capEvidence(input);
  const evidence = evidenceFor(state);
  const question = questionFor(state);
  const sources = evidence.map((chunk, index) => ({
    n: index + 1,
    chunkId: chunk.chunkId,
    filename: chunk.filename,
    page: chunk.page,
    tsStart: chunk.tsStart,
    tsEnd: chunk.tsEnd,
    score: chunk.score,
    external: chunk.external,
    ...(env.AGENT_DEBUG ? { text: chunk.text.slice(0, MAX_CHARS_PER_SOURCE) } : {}),
  }));

  // The sufficiency gate is authoritative. Synthesising from evidence the gate
  // already judged insufficient would make the abstention path decorative, and
  // the trace would show a decision the answer contradicts.
  if (state.decision === 'abstain' || evidence.length === 0) {
    const text =
      state.gradeFailed && !state.gradedOk
        ? GRADING_FAILED_TEXT
        : state.llmGradeFailed && !state.llmGraded
          ? LIMITED_CHECK_TEXT
          : ABSTENTION_TEXT;
    ctx.onToken(text);
    stage.complete({ stage: 'synthesise', abstained: true, characters: text.length, question, sources });
    return { ...state, answer: text, abstained: true };
  }

  const prompt = `Question: ${question}

Sources:
${buildContext(state, question)}

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
    stage.complete({
      stage: 'synthesise',
      abstained: false,
      characters: trimmed.length,
      question,
      sources,
    });
    return { ...state, answer: trimmed, abstained: false };
  } catch (cause) {
    const message = toError(cause).message;
    stage.fail(message);
    ctx.onToken(SYNTHESIS_FAILED_TEXT);
    return { ...state, answer: SYNTHESIS_FAILED_TEXT, abstained: true };
  }
}
