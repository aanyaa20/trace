import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExtractBlock } from '@trace/contracts';
import { htmlToText } from '../services/html.js';
import { headingsOf, planChunks, sectionAt } from './chunk.js';

const OPTIONS = { targetChars: 800, overlapChars: 150 };

function block(overrides: Partial<ExtractBlock>): ExtractBlock {
  return {
    ordinal: 0,
    kind: 'text',
    source: 'text',
    text: '',
    page: null,
    tsStart: null,
    tsEnd: null,
    bbox: null,
    imagePath: null,
    section: null,
    ...overrides,
  };
}

const para = (topic: string): string =>
  Array.from({ length: 6 }, (_, i) => `${topic} sentence number ${i + 1} explains one more detail.`).join(' ');

test('headings are found with their position and title', () => {
  const found = headingsOf('# Intro\nText.\n## Method 2.1\nMore.');
  assert.deepEqual(
    found.map((heading) => heading.title),
    ['Intro', 'Method 2.1'],
  );
  assert.equal(sectionAt(found, 20, 30, null), 'Method 2.1');
  assert.equal(sectionAt(found, 0, 5, null), 'Intro');
  assert.equal(sectionAt([], 0, 5, 'fallback'), 'fallback');
});

test('a long document starts a new chunk at each heading and tags every chunk', () => {
  const text = `# Retriever\n${para('Retriever')}\n\n# Generator\n${para('Generator')}\n\n# Training\n${para('Training')}`;
  const chunks = planChunks([block({ text })], OPTIONS);

  assert.ok(chunks.length >= 3, `expected a chunk per section, got ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.section, 'every chunk carries a section');
    // A chunk tagged "Generator" must actually contain generator text.
    assert.ok(chunk.text.includes(chunk.section!), `${chunk.section} not in its own chunk`);
  }
  assert.deepEqual(
    [...new Set(chunks.map((chunk) => chunk.section))],
    ['Retriever', 'Generator', 'Training'],
  );
});

test('character offsets still point at the chunk text after structure-aware splitting', () => {
  const text = `# Retriever\n${para('Retriever')}\n\n# Generator\n${para('Generator')}`;
  for (const chunk of planChunks([block({ text })], OPTIONS)) {
    const span = text.slice(chunk.charStart!, chunk.charEnd!);
    assert.ok(span.startsWith(chunk.text.slice(0, 30)), 'offsets resolve to the chunk text');
  }
});

test("an extractor's section (a PDF page heading, a slide title) is kept", () => {
  const chunks = planChunks(
    [block({ text: 'Short slide text.', page: 3, section: 'Transformer basics' })],
    OPTIONS,
  );
  assert.equal(chunks[0]?.section, 'Transformer basics');
  assert.equal(chunks[0]?.page, 3, 'the slide number survives as the page');
});

test('transcript chunks keep their timestamp span and section', () => {
  const segments = [0, 5, 10].map((start, i) =>
    block({ ordinal: i, source: 'asr', text: `segment ${i}`, tsStart: start, tsEnd: start + 5, section: null }),
  );
  const [merged] = planChunks(segments, OPTIONS);
  assert.equal(merged?.tsStart, 0);
  assert.equal(merged?.tsEnd, 15);
});

test('HTML keeps its headings as heading lines and table rows as rows', () => {
  const text = htmlToText(
    '<html><head><title>RAG</title></head><body><nav>menu</nav><h2>Process <a>[ edit ]</a></h2>' +
      '<p>RAG retrieves.</p><table><tr><th>Student</th><th>Score</th></tr><tr><td>Aanya</td><td>91</td></tr></table></body></html>',
  );
  assert.match(text, /^# RAG/);
  assert.match(text, /^## Process$/m);
  assert.match(text, /Aanya \| 91 \|/);
  assert.ok(!text.includes('menu'), 'navigation chrome is dropped');
  assert.ok(!/edit/i.test(text), 'wiki edit links are dropped');
});
