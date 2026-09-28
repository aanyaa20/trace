import { evidenceTypeOf, type EvidenceType, type RegionType } from '@trace/contracts';
import type { AgentState } from './state.js';

/**
 * What kind of evidence a question needs, from its wording alone.
 *
 * The analysis model is asked the same thing and is usually better at it, but
 * the analysis stage is optional — on a rate limit it is skipped — and a
 * question like "what was it in 2024?" must still reach the chart. So this is
 * the floor, deterministic and cheap, and it also catches the model calling a
 * value-in-a-year question "text".
 */
export function classifyEvidence(question: string): EvidenceType {
  const q = question.toLowerCase();

  const visual =
    /\b(figure|fig\.|image|photo|photograph|picture|illustration|drawing|logo|icon|screenshot|pictured|depict\w*|look(s)? like|shown in the|visual)\b/.test(q);
  const diagram = /\b(diagram|flow ?chart|architecture|pipeline diagram|schematic|arrow|flow)\b/.test(q);
  const chart =
    /\b(chart|graph|plot|bar|axis|trend|growth|grow|grew|increase|decrease|decline|market sizes?|forecast|projection|peak)\b/.test(q) ||
    /\b(in|by|from|between|since|until|to) (19|20)\d\d\b/.test(q) ||
    /\b(highest|lowest|largest|smallest|maximum|minimum)\b.*\b(year|value|month|quarter)\b/.test(q) ||
    /\bwhich (year|month|quarter)\b/.test(q);
  const table =
    /\b(table|row|column|score|scored|marks?|grade|rank(ed|ing)?|which (student|person|item|product|country|team))\b/.test(q) ||
    /\blist (all|every|each)\b/.test(q);
  const compare = /\b(compare|comparison|versus|vs\.?|both|consistent with|agree with)\b/.test(q);

  const kinds = [chart && 'chart', table && 'table', diagram && 'diagram', visual && 'visual'].filter(
    Boolean,
  ) as EvidenceType[];
  if (compare && kinds.length > 0) return 'mixed';
  if (kinds.length > 1) return 'mixed';
  return kinds[0] ?? 'text';
}

/**
 * The evidence type retrieval acts on: the analysis model's answer, unless it
 * said "text" for a question whose wording plainly points at data or at a
 * picture, in which case both are searched. A false "mixed" costs one extra
 * filtered search; a false "text" costs the answer.
 */
export function evidenceRoute(state: AgentState, question: string): EvidenceType {
  const fromModel = evidenceTypeOf(state.analysis);
  const fromWords = classifyEvidence(question);
  if (!fromModel) return fromWords;
  if (fromModel === 'text' && fromWords !== 'text') return 'mixed';
  return fromModel;
}

/** The region types a question of each evidence type is looked for in. */
export const REGIONS_FOR: Record<EvidenceType, RegionType[]> = {
  text: [],
  chart: ['chart', 'table'],
  table: ['table', 'chart'],
  diagram: ['diagram', 'photo', 'screenshot'],
  visual: ['photo', 'diagram', 'screenshot', 'chart', 'handwriting', 'form'],
  mixed: ['chart', 'table', 'diagram', 'photo', 'screenshot', 'handwriting', 'form'],
};
