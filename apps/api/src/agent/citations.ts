import type { Citation } from '@trace/contracts';
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
      external: chunk.external,
      externalUrl: chunk.externalUrl,
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

export async function citations(state: AgentState, ctx: AgentContext): Promise<AgentState> {
  const stage = ctx.bus.begin('citations', state.iteration);
  const resolved = resolveCitations(state);

  // An answer that claimed something but grounded none of it is exactly the
  // failure mode this system exists to avoid.
  const groundless = !state.abstained && resolved.citations.length === 0;
  const answer = groundless ? ABSTENTION_TEXT : resolved.answer;

  stage.complete({
    stage: 'citations',
    citations: resolved.citations,
    rejectedMarkers: resolved.rejectedMarkers,
  });

  return {
    ...state,
    answer,
    abstained: state.abstained || groundless,
    citations: groundless ? [] : resolved.citations,
  };
}
