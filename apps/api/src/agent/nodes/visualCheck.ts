import type { RegionType, RetrievedChunk, VisualReading } from '@trace/contracts';
import { env } from '../../env.js';
import { toError } from '../../errors.js';
import { hybridSearch } from '../../retrieval/hybrid.js';
import { mlClient } from '../../services/ml.js';
import type { AgentContext, AgentState } from '../state.js';
import { searchQuery } from './analyse.js';
import { grade } from './grade.js';
import { rerank } from './rerank.js';

const VISUAL_REGIONS: RegionType[] = ['chart', 'table', 'diagram', 'photo', 'screenshot', 'form', 'handwriting'];

/** Regions worth cropping to: the question is about the thing in the box. A
 *  text region or a whole-image overview is asked about the whole image. */
const CROPPABLE = new Set<RegionType>(['chart', 'table', 'diagram', 'photo', 'screenshot']);

/**
 * The images a vision model should look at, best first: a chart or table the
 * question retrieved, then any other chunk from an image. One reading per
 * picture region, so two chunks from one screenshot do not spend two calls
 * asking the same question of the same pixels.
 */
export function imagesToRead(pool: RetrievedChunk[], max: number): RetrievedChunk[] {
  const withImage = pool.filter((chunk) => chunk.imagePath && !chunk.external);
  const rank = (chunk: RetrievedChunk): number =>
    (chunk.visual && chunk.visual.type !== 'text' ? 1 : 0) + (chunk.rerankScore ?? 0);
  const picked: RetrievedChunk[] = [];
  const seen = new Set<string>();
  for (const chunk of [...withImage].sort((a, b) => rank(b) - rank(a))) {
    const crop = chunk.visual && CROPPABLE.has(chunk.visual.type) ? chunk.visual.bbox : null;
    const key = `${chunk.imagePath}|${crop ? crop.join(',') : 'whole'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(chunk);
    if (picked.length >= max) break;
  }
  return picked;
}

/**
 * The last look before abstaining. Text retrieval has come up short, but the
 * answer may be in a picture: a bar the OCR could not pair with its label, a
 * photo nobody described, a table whose cells were read out of order. So:
 *
 *   1. search the charts, tables and pictures on their own, where a region
 *      competes only with other regions rather than with every paragraph;
 *   2. ask a vision model the question of the images those searches and the
 *      loop found, cropped to the region when the chunk is one;
 *   3. grade what came back like any other evidence.
 *
 * A vision reading is cited as the image it came from. It enters evidence
 * only through the grader, and the sufficiency gate decides afterwards as it
 * always does, so "the image does not show it" still ends in an abstention.
 */
export async function visualCheck(state: AgentState, ctx: AgentContext): Promise<AgentState> {
  const stage = ctx.bus.begin('visual_check', state.iteration);
  const question = searchQuery(state);
  const evidenceIds = new Set(state.relevant.map((chunk) => chunk.chunkId));

  try {
    const regional = await hybridSearch({
      kbId: state.kbId,
      query: question,
      regionTypes: VISUAL_REGIONS,
      limit: 8,
      ...(state.documentId ? { documentIds: [state.documentId, ...state.attachedIds] } : {}),
    });
    const fresh = regional.chunks.filter((chunk) => !evidenceIds.has(chunk.chunkId));
    const pool = [...state.candidates, ...fresh].filter((chunk) => !evidenceIds.has(chunk.chunkId));

    const readings: VisualReading[] = [];
    const read = new Map<string, RetrievedChunk>();
    let visionAvailable = env.VISUAL_CHECK_MAX_IMAGES > 0;

    for (const chunk of imagesToRead(pool, env.VISUAL_CHECK_MAX_IMAGES)) {
      const region = chunk.visual;
      const crop = region && CROPPABLE.has(region.type) ? region.bbox : null;
      const reply = await mlClient.visionAnswer({
        path: chunk.imagePath!,
        question,
        ...(crop ? { bbox: crop } : {}),
      });
      if (!reply.available) {
        visionAvailable = false;
        break;
      }
      readings.push({
        chunkId: chunk.chunkId,
        filename: chunk.filename,
        regionType: region?.type ?? null,
        regionTitle: region?.title ?? null,
        found: reply.found,
        answer: reply.answer,
        model: reply.model,
      });
      if (reply.found && reply.answer) {
        const what = region && region.type !== 'text' ? `the ${region.type}${region.title ? ` "${region.title}"` : ''}` : 'the image';
        // The chunk it came from stays attached, so the citation opens the
        // same image and region, and the support check can see both.
        read.set(chunk.chunkId, {
          ...chunk,
          source: 'vision',
          text: `Read from ${what} in ${chunk.filename} by a vision model: ${reply.answer}${
            reply.evidence ? ` (${reply.evidence})` : ''
          }\n\n${chunk.text}`,
        });
      }
    }

    const candidates = [
      ...read.values(),
      ...fresh.filter((chunk) => !read.has(chunk.chunkId)),
    ];

    stage.complete({
      stage: 'visual_check',
      regionCandidates: fresh.length,
      readings,
      visionAvailable,
    });

    if (candidates.length === 0) return { ...state, visualChecked: true };

    let next: AgentState = { ...state, candidates, reranked: false, visualChecked: true };
    next = await rerank(next, ctx);
    // A reading answers the question by construction; the reranker must not
    // prune it before the grader sees it.
    const kept = new Set(next.candidates.map((chunk) => chunk.chunkId));
    next = { ...next, candidates: [...next.candidates, ...[...read.values()].filter((chunk) => !kept.has(chunk.chunkId))] };
    return await grade(next, ctx);
  } catch (cause) {
    stage.fail(toError(cause).message);
    return { ...state, visualChecked: true };
  }
}
