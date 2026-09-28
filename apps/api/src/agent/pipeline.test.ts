import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RetrievedChunk } from '@trace/contracts';
import { weightedRrf } from '../retrieval/hybrid.js';
import { claimOf, resolveCitations, splitSentences, stripUnsupported } from './citations.js';
import { nextQueries } from './graph.js';
import { keywordQuery } from './nodes/analyse.js';
import { rerankVerdicts } from './nodes/grade.js';
import { pruneReranked } from './nodes/rerank.js';
import { namedLocations } from './nodes/retrieve.js';
import { confidenceOf, decide, isStrong } from './nodes/sufficiency.js';
import { capEvidence } from './nodes/synthesise.js';
import { initialState, type AgentState } from './state.js';

let seq = 0;
function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  return {
    chunkId: id,
    documentId: '11111111-1111-4111-8111-111111111111',
    filename: 'paper.pdf',
    modality: 'pdf',
    source: 'text',
    text: `passage ${seq}`,
    score: 0.5,
    page: 1,
    charStart: 0,
    charEnd: 10,
    tsStart: null,
    tsEnd: null,
    imagePath: null,
    external: false,
    externalUrl: null,
    rerankScore: null,
    gradedBy: null,
    ...overrides,
  };
}

function state(overrides: Partial<AgentState> = {}): AgentState {
  return {
    ...initialState({ kbId: 'kb', userQuery: 'What is the role of the generator in RAG?', mode: 'agentic' }),
    ...overrides,
  };
}

const LIMITS = {
  minRelevantChunks: 2,
  minScore: 0.55,
  minRerankScore: 0.2,
  singleSourceScore: 0.85,
  singleSourceRerank: 0.95,
};

// --- Hybrid fusion -----------------------------------------------------------

test('weighted RRF with equal weights rewards agreement between the branches', () => {
  const fused = weightedRrf(['a', 'b', 'c'], ['c', 'a', 'd'], { dense: 1, sparse: 1, k: 60 });
  assert.equal(fused[0]?.id, 'a', 'ranked by both branches, near the top of each');
  assert.deepEqual(new Set(fused.map((entry) => entry.id)), new Set(['a', 'b', 'c', 'd']));
  assert.deepEqual(fused.find((entry) => entry.id === 'd')?.dense, null);
});

test('raising the sparse weight lets an exact keyword match outrank a semantic one', () => {
  // "TB-2048" is ranked first by BM25 only; the dense branch prefers a
  // passage that is merely about the same topic.
  const dense = ['semantic', 'x', 'y', 'exact'];
  const sparse = ['exact', 'z'];
  const even = weightedRrf(dense, sparse, { dense: 1, sparse: 1, k: 60 });
  const lexical = weightedRrf(dense, sparse, { dense: 1, sparse: 3, k: 60 });
  assert.equal(even[0]?.id, 'exact', 'present in both branches already wins');
  assert.equal(lexical[0]?.id, 'exact');
  assert.ok(
    (lexical[0]?.score ?? 0) - (lexical[1]?.score ?? 0) > (even[0]?.score ?? 0) - (even[1]?.score ?? 0),
    'a heavier sparse weight widens the margin',
  );
});

// --- Reranking ---------------------------------------------------------------

test('reranking reorders by cross-encoder score and prunes to top-k above the floor', () => {
  const candidates = [chunk(), chunk(), chunk(), chunk()];
  const { ordered, kept } = pruneReranked(candidates, [0.1, 0.9, 0.005, 0.6], {
    topK: 2,
    minScore: 0.01,
    minKeep: 0,
  });
  assert.deepEqual(
    ordered.map((entry) => entry.rerankScore),
    [0.9, 0.6, 0.1, 0.005],
  );
  assert.deepEqual(kept.map((entry) => entry.chunkId), [candidates[1]!.chunkId, candidates[3]!.chunkId]);
});

test('noise below the rerank floor is not graded, beyond the guaranteed few', () => {
  const candidates = [chunk(), chunk(), chunk(), chunk()];
  const { kept } = pruneReranked(candidates, [0.004, 0.001, 0.0099, 0.002], {
    topK: 8,
    minScore: 0.01,
    minKeep: 2,
  });
  // The two best — including the 0.0099 statistics block the cross-encoder
  // misjudged — still reach the grader; the rest do not.
  assert.deepEqual(kept.map((entry) => entry.rerankScore), [0.0099, 0.004]);
});

// --- Grading fallback ----------------------------------------------------------

test('when the LLM grader is unavailable, reranker scores decide instead of nothing', () => {
  const strong = chunk({ rerankScore: 0.26 });
  const weak = chunk({ rerankScore: 0.05 });
  const { kept, grades } = rerankVerdicts([strong, weak], 0.2);
  assert.deepEqual(kept.map((entry) => entry.chunkId), [strong.chunkId]);
  assert.equal(kept[0]?.gradedBy, 'rerank');
  assert.equal(kept[0]?.score, 0.26);
  assert.equal(grades.length, 2);
});

test('a chunk with no reranker score gets no fallback verdict', () => {
  const { kept, grades } = rerankVerdicts([chunk({ rerankScore: null })], 0.2);
  assert.equal(kept.length, 0);
  assert.equal(grades.length, 0);
});

// --- Sufficiency and confidence -------------------------------------------------

test('each judge is held to its own threshold', () => {
  assert.equal(isStrong(chunk({ score: 0.3, gradedBy: 'rerank' }), LIMITS), true);
  assert.equal(isStrong(chunk({ score: 0.3, gradedBy: 'llm' }), LIMITS), false);
  assert.equal(isStrong(chunk({ score: 0.6, gradedBy: 'llm' }), LIMITS), true);
});

test('reranker-judged evidence can answer a question the grader could not grade', () => {
  const relevant = [
    chunk({ score: 0.99, gradedBy: 'rerank' }),
    chunk({ score: 0.26, gradedBy: 'rerank' }),
  ];
  assert.equal(decide(state({ relevant }), LIMITS).decision, 'answer');
});

test('a fact stated once is answered when both judges rate its passage highly', () => {
  // "What is TB-2048?" — one passage in the corpus, graded 0.95, reranked 0.999.
  const relevant = [chunk({ score: 0.95, gradedBy: 'llm', rerankScore: 0.999 })];
  assert.equal(decide(state({ relevant, iteration: 1 }), LIMITS).decision, 'answer');
});

test('a single passage the reranker doubts still needs corroboration', () => {
  const relevant = [chunk({ score: 0.95, gradedBy: 'llm', rerankScore: 0.1 })];
  assert.equal(decide(state({ relevant, iteration: 1 }), LIMITS).decision, 'retry');
});

test('a single reranker-only verdict is decisive only near certainty', () => {
  // "How many documents is the dump split into?" with the grader rate-limited:
  // the reranker scored the answering passage 1.000.
  const certain = [chunk({ score: 0.9996, gradedBy: 'rerank', rerankScore: 0.9996 })];
  assert.equal(decide(state({ relevant: certain, iteration: 1 }), LIMITS).decision, 'answer');
  const likely = [chunk({ score: 0.8, gradedBy: 'rerank', rerankScore: 0.8 })];
  assert.equal(decide(state({ relevant: likely, iteration: 1 }), LIMITS).decision, 'retry');
});

test('too little evidence retries before it abstains', () => {
  const relevant = [chunk({ score: 0.7, gradedBy: 'llm' })];
  assert.equal(decide(state({ relevant, iteration: 1 }), LIMITS).decision, 'retry');
});

test('retrieval confidence is computed from real scores, and zero with no evidence', () => {
  const none = confidenceOf(state());
  assert.equal(none.retrievalConfidence, 0);
  assert.equal(none.basis, 'none');

  const relevant = [
    chunk({ score: 0.9, gradedBy: 'llm' }),
    chunk({ score: 0.6, gradedBy: 'llm' }),
    chunk({ score: 0.3, gradedBy: 'rerank' }),
    chunk({ score: 0.1, gradedBy: 'rerank' }),
  ];
  const some = confidenceOf(state({ relevant, retrievedCount: 20, candidates: relevant.slice(0, 3) }));
  assert.equal(some.topScore, 0.9);
  assert.equal(Math.round(some.retrievalConfidence * 100), 60, 'mean of the best three');
  assert.equal(some.candidateCount, 20);
  assert.equal(some.rerankedCount, 3);
  assert.equal(some.evidenceCount, 4);
  assert.equal(some.basis, 'mixed');
});

// --- Query rewriting ----------------------------------------------------------------

test('the keyword form keeps entities, numbers and codes verbatim', () => {
  assert.equal(keywordQuery('What is the role of the generator in RAG?'), 'generator RAG');
  assert.equal(keywordQuery('What is TB-2048?'), 'TB-2048');
  assert.equal(keywordQuery('What does section 3.2 say about equation 4.1?'), 'section 3.2 equation 4.1');
  assert.equal(keywordQuery('Who is the author of 2005.11401v4.pdf?'), 'author 2005.11401v4.pdf');
});

test('a retry never repeats a query that was already run', () => {
  const base = state({
    analysis: {
      intent: 'definition',
      modalityHints: [],
      rewrites: ['RAG generator role', 'generation component RAG'],
      reasoning: '',
    },
    tried: ['What is the role of the generator in RAG?', 'RAG generator role', 'generation component RAG'],
  });
  const next = nextQueries(base);
  assert.ok(next.length > 0);
  for (const query of next) {
    assert.ok(!base.tried.map((q) => q.toLowerCase()).includes(query.toLowerCase()), query);
  }
});

test('unused rewrites are tried before keyword forms', () => {
  const base = state({
    analysis: { intent: 'x', modalityHints: [], rewrites: ['alpha beta', 'gamma'], reasoning: '' },
    tried: ['What is the role of the generator in RAG?', 'alpha beta'],
  });
  assert.deepEqual(nextQueries(base), ['gamma']);
});

// --- Synthesis context cap ------------------------------------------------------------

test('capping evidence keeps the best sources and the state consistent with the prompt', () => {
  const relevant = Array.from({ length: 12 }, (_, index) => chunk({ score: index / 12 }));
  const capped = capEvidence(state({ relevant }), 8);
  assert.equal(capped.relevant.length, 8);
  assert.equal(capped.relevant[0]?.score, 11 / 12);
  assert.ok(capped.relevant.every((entry) => entry.score >= 4 / 12));
});

// --- Citation correctness ------------------------------------------------------------------

test('sentences split on terminal punctuation but not inside numbers, and keep their markers', () => {
  const parts = splitSentences('Section 3.2 defines RAG.[^1] The generator writes the answer [^2]. Done.');
  const sentences = parts.filter((_, index) => index % 2 === 0);
  assert.deepEqual(sentences, [
    'Section 3.2 defines RAG.[^1]',
    'The generator writes the answer [^2].',
    'Done.',
  ]);
  assert.equal(parts.join(''), 'Section 3.2 defines RAG.[^1] The generator writes the answer [^2]. Done.');
  assert.equal(claimOf('The generator writes the answer [^2].'), 'The generator writes the answer .');
});

test('an unsupported citation is removed, and a sentence left with none is dropped', () => {
  const answer =
    'RAG pairs a retriever with a generator.[^1] RAG was invented in 2015.[^2] It cites sources.[^1][^2]';
  const result = stripUnsupported(answer, (_claim, marker) => marker !== 2);
  assert.equal(result.answer, 'RAG pairs a retriever with a generator.[^1] It cites sources.[^1]');
  assert.deepEqual(result.unsupported, [2]);
  assert.equal(result.droppedSentences, 1);
});

test('a citation resolves to the exact chunk, page and file it names', () => {
  const first = chunk({ filename: 'a.pdf', page: 4 });
  const second = chunk({ filename: 'lecture.mp4', page: null, tsStart: 763, tsEnd: 797, modality: 'video' });
  const resolved = resolveCitations(
    state({ relevant: [first, second], answer: 'One.[^2] Two.[^1] Invented.[^9]' }),
  );
  assert.deepEqual(resolved.rejectedMarkers, [9], 'a marker to a source never supplied is rejected');
  const byMarker = new Map(resolved.citations.map((citation) => [citation.marker, citation]));
  assert.equal(byMarker.get(1)?.chunkId, first.chunkId);
  assert.equal(byMarker.get(1)?.page, 4);
  assert.equal(byMarker.get(1)?.filename, 'a.pdf');
  assert.equal(byMarker.get(2)?.tsStart, 763);
  assert.equal(byMarker.get(2)?.filename, 'lecture.mp4');
  assert.ok(!resolved.answer.includes('[^9]'));
});

// --- Metadata lookup ----------------------------------------------------------------

test('a page or slide named in the question is extracted exactly', () => {
  assert.deepEqual(namedLocations('What does slide 3 say?'), [3]);
  assert.deepEqual(namedLocations('Summarise page 12 and p. 4'), [12, 4]);
  assert.deepEqual(namedLocations('What is TB-2048?'), []);
  assert.deepEqual(namedLocations('pages of history'), []);
});

test('a located passage the grader accepts is enough evidence on its own', () => {
  const slide = chunk({ score: 0.7, gradedBy: 'llm', page: 3, rerankScore: 0.02 });
  const decision = decide(state({ relevant: [slide], pinned: [slide.chunkId] }), LIMITS);
  assert.equal(decision.decision, 'answer');
});
