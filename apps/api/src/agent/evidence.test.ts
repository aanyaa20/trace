import test from 'node:test';
import assert from 'node:assert/strict';
import type { QueryAnalysis, RetrievedChunk, VisualRegion } from '@trace/contracts';
import { classifyEvidence, evidenceRoute } from './evidence.js';
import { focusWindow } from './nodes/grade.js';
import { imagesToRead } from './nodes/visualCheck.js';
import { initialState } from './state.js';

const KB = '00000000-0000-4000-8000-000000000000';

test('routes each kind of question to the evidence that answers it', () => {
  const cases: Array<[string, string]> = [
    ['What are the key benefits of AI in education?', 'text'],
    ['What was the AI in Education market size in 2024?', 'chart'],
    ['How much did the market grow from 2021 to 2024?', 'chart'],
    ['Which year had the highest market size?', 'chart'],
    ['What was revenue in 2024?', 'chart'],
    ['What score did Aanya get?', 'table'],
    ['Which student scored highest?', 'table'],
    ['What does Figure 2 show?', 'visual'],
    ['What does the robot image in the introduction represent?', 'visual'],
    ['List all the years and their corresponding market sizes.', 'mixed'],
    ['Compare the chart with the written information in the document.', 'mixed'],
    ['Who is the CEO of the AI in Education market?', 'text'],
  ];
  for (const [question, expected] of cases) {
    assert.equal(classifyEvidence(question), expected, question);
  }
});

test('a model that says "text" for a value-in-a-year question still reaches the chart', () => {
  const analysis: QueryAnalysis = {
    intent: 'factual lookup',
    evidenceType: 'text',
    modalityHints: [],
    rewrites: ['market size 2024'],
    reasoning: 'r',
  };
  const state = { ...initialState({ kbId: KB, userQuery: 'q', mode: 'agentic' }), analysis };
  assert.equal(evidenceRoute(state, 'What was the market size in 2024?'), 'mixed');
});

test('an unknown evidence type from the model falls back to the wording', () => {
  const analysis: QueryAnalysis = {
    intent: 'lookup',
    evidenceType: 'numeric',
    modalityHints: [],
    rewrites: ['x'],
    reasoning: 'r',
  };
  const state = { ...initialState({ kbId: KB, userQuery: 'q', mode: 'agentic' }), analysis };
  assert.equal(evidenceRoute(state, 'What score did Aanya get?'), 'table');
});

// The regression this module exists for: the answer sat after character 800
// of a 2,197-character chunk, and the grader was shown only the first 800.
test('the grader sees the part of a long passage the question is about', () => {
  const filler = 'Artificial intelligence is transforming the education sector. '.repeat(20);
  const text = `${filler}\nAI in Education Market Size (USD Billion)\n2021 12.1\n2024 28.9\n2026 48.2`;
  assert.ok(text.length > 1200);
  const window = focusWindow(text, 'What was the AI in Education market size in 2024?', 800);
  assert.ok(window.includes('28.9'), window);
  assert.ok(window.length <= 800 + 4);
});

test('a short passage is shown whole', () => {
  assert.equal(focusWindow('short text', 'anything', 800), 'short text');
});

function chunk(id: string, overrides: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    chunkId: `00000000-0000-4000-8000-00000000000${id}`,
    documentId: KB,
    filename: 'poster.png',
    modality: 'image',
    source: 'ocr',
    text: 'text',
    score: 0.1,
    page: null,
    charStart: null,
    charEnd: null,
    tsStart: null,
    tsEnd: null,
    imagePath: '/data/uploads/poster.png',
    section: null,
    external: false,
    externalUrl: null,
    rerankScore: 0.5,
    gradedBy: null,
    visual: null,
    ...overrides,
  };
}

const CHART: VisualRegion = {
  id: 'r3',
  type: 'chart',
  title: 'Market Size',
  unit: 'USD Billion',
  description: null,
  text: null,
  columns: ['year', 'value'],
  data: [{ year: 2024, value: 28.9 }],
  bbox: [0.06, 0.5, 0.44, 0.68],
  origin: 'layout',
  estimated: false,
  ocrAgreement: 1,
};

test('the visual check looks at a chart before a paragraph from the same image', () => {
  const paragraph = chunk('1', { rerankScore: 0.9 });
  const chart = chunk('2', { rerankScore: 0.2, visual: CHART });
  const picked = imagesToRead([paragraph, chart], 1);
  assert.deepEqual(
    picked.map((item) => item.chunkId),
    [chart.chunkId],
  );
});

test('two chunks of one whole image are read once, and web results never', () => {
  const a = chunk('1', {});
  const b = chunk('2', {});
  const web = chunk('3', { external: true, imagePath: null });
  assert.equal(imagesToRead([a, b, web], 5).length, 1);
});
