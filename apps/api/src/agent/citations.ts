import type { Citation, VisualRegion } from '@trace/contracts';
import { env } from '../env.js';
import { toError } from '../errors.js';
import { logger } from '../logger.js';
import { mlClient } from '../services/ml.js';
import { evidenceFor, type AgentContext, type AgentState } from './state.js';
import { ABSTENTION_TEXT } from './nodes/synthesise.js';

// Both marker spellings are accepted. The prompt asks for [^n], but models
// drift to the plain [n] footnote form often enough that rejecting it would
// discard a correctly grounded answer over punctuation.
const MARKER = /\[\^?(\d+)\]/g;
const SNIPPET_CHARS = 280;

export interface ResolvedCitations {
  citations: Citation[];
  /** Markers the model emitted that pointed at no source we supplied. */
  rejectedMarkers: number[];
  answer: string;
}

/**
 * What a citation says about the region it points into. A merged run of
 * paragraphs is still text; only a chart, table, photo or diagram is named,
 * because "the Market Size chart" is a place a reader can look for and
 * "text region r1+r2" is not.
 */
export function regionOf(visual: VisualRegion | null | undefined): Citation['region'] {
  if (!visual) return null;
  return { id: visual.id, type: visual.type, title: visual.title, bbox: visual.bbox };
}

/**
 * Resolves every [^n] to a concrete location and drops the ones that resolve
 * to nothing. A model that invents a source number has produced an uncited
 * claim, so the marker is stripped rather than shown; if nothing survives,
 * the answer is replaced with an abstention.
 *
 * This follows agentic_typed_rag_pydanticai, which verifies that a cited span
 * really occurs in the chunk and refuses when no citation survives. See
 * docs/PRIOR_ART.md.
 */
export function resolveCitations(state: AgentState): ResolvedCitations {
  const evidence = evidenceFor(state);
  const used = new Map<number, Citation>();
  const rejected = new Set<number>();

  for (const match of state.answer.matchAll(MARKER)) {
    const marker = Number(match[1]);
    const chunk = evidence[marker - 1];

    if (!chunk) {
      rejected.add(marker);
      continue;
    }
    if (used.has(marker)) continue;

    used.set(marker, {
      marker,
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      filename: chunk.filename,
      modality: chunk.modality,
      source: chunk.source,
      page: chunk.page,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      tsStart: chunk.tsStart,
      tsEnd: chunk.tsEnd,
      imagePath: chunk.imagePath,
      snippet: chunk.text.slice(0, SNIPPET_CHARS),
      section: chunk.section,
      external: chunk.external,
      externalUrl: chunk.externalUrl,
      region: regionOf(chunk.visual),
    });
  }

  let answer = state.answer;
  for (const marker of rejected) {
    answer = answer.replaceAll(`[^${marker}]`, '').replaceAll(`[${marker}]`, '');
  }
  // Normalise the surviving markers so the client renders one form.
  answer = answer.replace(/\[(\d+)\]/g, '[^$1]');
  answer = answer.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:])/g, '$1').trim();

  // Renumber what survived to 1..n. A marker is an index into the evidence
  // list, so a model that cites the second and fourth passages leaves the
  // reader looking at a 2 and a 4 with no 1 or 3 anywhere on the page — which
  // reads as two citations having gone missing. The numbering a reader sees
  // is a footnote sequence, not a pointer into our retrieval internals.
  const ordered = [...used.values()].sort((a, b) => a.marker - b.marker);
  const renumbered = new Map(ordered.map((citation, index) => [citation.marker, index + 1]));

  // Rewritten in one pass against the original markers, so a source moving
  // from 4 to 2 cannot collide with whatever already held 2.
  answer = answer.replace(/\[\^(\d+)\]/g, (whole, digits: string) => {
    const next = renumbered.get(Number(digits));
    return next === undefined ? whole : `[^${next}]`;
  });

  return {
    citations: ordered.map((citation) => ({
      ...citation,
      marker: renumbered.get(citation.marker) ?? citation.marker,
    })),
    rejectedMarkers: [...rejected].sort((a, b) => a - b),
    answer,
  };
}

/**
 * Splits an answer into sentences and the separators between them, so it can
 * be rebuilt exactly after a sentence is removed. A sentence ends at . ! or ?
 * followed by any citation markers — "claim.[^1]" and "claim [^1]." both keep
 * their marker — and every line break is a boundary, so list items stand alone.
 * A decimal like "3.2" is not a boundary: the split needs whitespace after it.
 */
export function splitSentences(answer: string): string[] {
  return answer.split(/((?<=[.!?](?:\s*\[\^?\d+\])*)[ \t]+|\n+)/);
}

const MARKER_ONLY = /\[\^?(\d+)\]/g;

/** The words of a sentence, markers removed, as the claim to be checked. */
export function claimOf(sentence: string): string {
  return sentence.replace(MARKER_ONLY, '').replace(/\s+/g, ' ').trim();
}

/**
 * Rebuilds the answer with unsupported markers removed. `supported(sentence,
 * marker)` is the verdict for one citation. A sentence that carried markers
 * and loses all of them is dropped: it made a claim no source was found to
 * support, and leaving it in uncited would present an unverified statement
 * with the same authority as a verified one.
 */
export function stripUnsupported(
  answer: string,
  supported: (claim: string, marker: number) => boolean,
): { answer: string; unsupported: number[]; droppedSentences: number } {
  const unsupported = new Set<number>();
  let droppedSentences = 0;

  const parts = splitSentences(answer).map((part, index) => {
    if (index % 2 === 1) return part; // a separator
    const markers = [...part.matchAll(MARKER_ONLY)].map((match) => Number(match[1]));
    if (markers.length === 0) return part;

    const claim = claimOf(part);
    const failing = markers.filter((marker) => !supported(claim, marker));
    if (failing.length === 0) return part;

    failing.forEach((marker) => unsupported.add(marker));
    if (failing.length === markers.length) {
      droppedSentences += 1;
      return '';
    }
    let kept = part;
    for (const marker of failing) {
      kept = kept.replaceAll(`[^${marker}]`, '').replaceAll(`[${marker}]`, '');
    }
    return kept;
  });

  const rebuilt = parts
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { answer: rebuilt, unsupported: [...unsupported].sort((a, b) => a - b), droppedSentences };
}

/** Claims shorter than this are headings, list labels or connectives. */
const MIN_CLAIM_CHARS = 20;

/**
 * Scores every cited sentence against the passage it cites, with the local
 * cross-encoder, and strips the citations that fall below CITATION_MIN_SUPPORT.
 * The threshold is low on purpose: a faithful paraphrase scores well above it,
 * and it exists to catch a marker pointing at a passage about something else
 * entirely. If the reranker is unavailable the check is skipped, not failed.
 */
async function checkSupport(state: AgentState): Promise<{ answer: string; unsupported: number[] }> {
  if (env.CITATION_MIN_SUPPORT <= 0 || state.abstained) return { answer: state.answer, unsupported: [] };
  const evidence = evidenceFor(state);

  const pairs = new Map<string, { claim: string; marker: number }>();
  splitSentences(state.answer).forEach((part, index) => {
    if (index % 2 === 1) return;
    const claim = claimOf(part);
    if (claim.length < MIN_CLAIM_CHARS) return;
    for (const match of part.matchAll(MARKER_ONLY)) {
      const marker = Number(match[1]);
      const chunk = evidence[marker - 1];
      // External results and images have no passage text worth scoring against.
      if (!chunk || chunk.external || chunk.text.trim().length === 0) continue;
      pairs.set(`${marker}\u0000${claim}`, { claim, marker });
    }
  });
  if (pairs.size === 0) return { answer: state.answer, unsupported: [] };

  const verdicts = new Map<string, number>();
  try {
    const byClaim = new Map<string, number[]>();
    for (const { claim, marker } of pairs.values()) {
      byClaim.set(claim, [...(byClaim.get(claim) ?? []), marker]);
    }
    await Promise.all(
      [...byClaim.entries()].map(async ([claim, markers]) => {
        const response = await mlClient.rerank({
          query: claim,
          passages: markers.map((marker) => evidence[marker - 1]!.text.slice(0, 2000)),
        });
        markers.forEach((marker, index) => {
          verdicts.set(`${marker}\u0000${claim}`, response.scores[index] ?? 1);
        });
      }),
    );
  } catch (cause) {
    logger.warn({ err: toError(cause).message }, 'citation support check skipped');
    return { answer: state.answer, unsupported: [] };
  }

  const result = stripUnsupported(state.answer, (claim, marker) => {
    const score = verdicts.get(`${marker}\u0000${claim}`);
    return score === undefined || score >= env.CITATION_MIN_SUPPORT;
  });
  return { answer: result.answer, unsupported: result.unsupported };
}

const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';

/**
 * Markers written with superscript digits — "[¹]", "[^²³]" — rewritten as
 * [^n]. A model drifts to them now and then; an invoice total came back as
 * "₹ 2,95,000.00 [¹]", matched no marker, and a correctly grounded answer
 * was replaced with an abstention over typography.
 */
export function normaliseMarkers(answer: string): string {
  return answer.replace(/\[\^?([⁰¹²³⁴⁵⁶⁷⁸⁹]+)\]/g, (_whole, digits: string) => {
    const n = [...digits].map((digit) => SUPERSCRIPT.indexOf(digit)).join('');
    return `[^${n}]`;
  });
}

export async function citations(raw: AgentState, ctx: AgentContext): Promise<AgentState> {
  const stage = ctx.bus.begin('citations', raw.iteration);
  const input = { ...raw, answer: normaliseMarkers(raw.answer) };
  const support = await checkSupport(input);
  const state = { ...input, answer: support.answer };
  const resolved = resolveCitations(state);

  // An answer that claimed something but grounded none of it is exactly the
  // failure mode this system exists to avoid.
  const groundless = !state.abstained && resolved.citations.length === 0;
  const answer = groundless ? ABSTENTION_TEXT : resolved.answer;

  stage.complete({
    stage: 'citations',
    citations: resolved.citations,
    rejectedMarkers: resolved.rejectedMarkers,
    unsupportedMarkers: support.unsupported,
  });

  return {
    ...state,
    answer,
    abstained: state.abstained || groundless,
    citations: groundless ? [] : resolved.citations,
  };
}
