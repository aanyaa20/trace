import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExtractBlock } from '@trace/contracts';
import { planChunks, splitSentences } from './chunk.js';

const OPTIONS = { targetChars: 800, overlapChars: 150 };

function textBlock(partial: Partial<ExtractBlock> & { text: string; ordinal: number }): ExtractBlock {
  return {
    kind: 'text',
    source: 'text',
    page: null,
    tsStart: null,
    tsEnd: null,
    bbox: null,
    imagePath: null,
    ...partial,
  };
}

test('sentences split on terminators but not on common abbreviations', () => {
  const parts = splitSentences('See Fig. 3 for detail. The result holds. Next section follows.');
  assert.equal(parts.length, 3);
  assert.match(parts[0]!, /Fig\. 3/);
});

test('a short page becomes one chunk carrying its page number', () => {
  const chunks = planChunks([textBlock({ ordinal: 0, text: 'Short page body.', page: 7, source: 'text' })], OPTIONS);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.page, 7);
  assert.equal(chunks[0]!.charStart, 0);
});

test('pages are never merged, so every chunk keeps one page number', () => {
  const chunks = planChunks(
    [
      textBlock({ ordinal: 0, text: 'Alpha content on one.', page: 1 }),
      textBlock({ ordinal: 1, text: 'Beta content on two.', page: 2 }),
    ],
    OPTIONS,
  );
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((c) => c.page), [1, 2]);
});

test('a long page splits, and every span resolves inside the page text', () => {
  const sentence = 'This sentence carries enough words to advance the character budget. ';
  const pageText = sentence.repeat(40);
  const chunks = planChunks([textBlock({ ordinal: 0, text: pageText, page: 4 })], OPTIONS);

  assert.ok(chunks.length > 1, 'expected the page to split');
  for (const chunk of chunks) {
    assert.equal(chunk.page, 4, 'page survives the split');
    assert.ok(chunk.charStart !== null && chunk.charEnd !== null);
    assert.ok(chunk.charStart! >= 0 && chunk.charEnd! <= pageText.length, 'span lies inside the page');
    assert.ok(chunk.charEnd! > chunk.charStart!, 'span is non-empty');
  }
});

test('transcript segments merge and the timestamp span widens to cover them', () => {
  const blocks: ExtractBlock[] = Array.from({ length: 12 }, (_, i) =>
    textBlock({
      ordinal: i,
      text: `Spoken fragment number ${i} discussing retrieval and grading in some detail.`,
      source: 'asr',
      tsStart: i * 5,
      tsEnd: i * 5 + 5,
    }),
  );

  const chunks = planChunks(blocks, OPTIONS);
  assert.ok(chunks.length >= 1 && chunks.length < blocks.length, 'segments merged');
  assert.equal(chunks[0]!.tsStart, 0, 'starts at the first segment');

  const last = chunks[chunks.length - 1]!;
  assert.equal(last.tsEnd, 60, 'ends at the last segment');
  for (const chunk of chunks) {
    assert.ok(chunk.tsStart !== null && chunk.tsEnd !== null, 'timestamps never lost');
    assert.ok(chunk.tsEnd! > chunk.tsStart!);
  }
});

test('image blocks stay whole and keep their file path', () => {
  const chunks = planChunks(
    [
      { kind: 'image', source: 'caption', text: '', page: null, tsStart: 30, tsEnd: 60, bbox: null, imagePath: '/data/uploads/f/frame-0001.jpg', ordinal: 0 },
      textBlock({ ordinal: 1, text: 'Adjacent narration.', source: 'asr', tsStart: 30, tsEnd: 35 }),
    ],
    OPTIONS,
  );

  const image = chunks.find((c) => c.kind === 'image');
  assert.ok(image, 'image chunk present');
  assert.equal(image!.imagePath, '/data/uploads/f/frame-0001.jpg');
  assert.equal(image!.tsStart, 30);
});

test('empty and whitespace-only blocks produce no chunks', () => {
  assert.equal(planChunks([textBlock({ ordinal: 0, text: '   \n  ', page: 1 })], OPTIONS).length, 0);
});

test('ordinals are contiguous from zero', () => {
  const chunks = planChunks(
    [
      textBlock({ ordinal: 0, text: 'One.', page: 1 }),
      textBlock({ ordinal: 1, text: 'Two.', page: 2 }),
      textBlock({ ordinal: 2, text: 'Three.', page: 3 }),
    ],
    OPTIONS,
  );
  assert.deepEqual(chunks.map((c) => c.ordinal), [0, 1, 2]);
});

test('an OCR page keeps the rendered image that OCR actually read', () => {
  const chunks = planChunks(
    [
      textBlock({
        ordinal: 0,
        text: 'Recovered text from a scanned page.',
        page: 1,
        source: 'ocr',
        imagePath: '/data/uploads/derived/doc/page-0001.png',
      }),
    ],
    OPTIONS,
  );
  assert.equal(chunks[0]!.imagePath, '/data/uploads/derived/doc/page-0001.png');
  assert.equal(chunks[0]!.page, 1);
});

test('a long OCR page keeps the render on every split chunk', () => {
  const body = 'Recovered sentence from the scan that is long enough to matter. '.repeat(30);
  const chunks = planChunks(
    [textBlock({ ordinal: 0, text: body, page: 3, source: 'ocr', imagePath: '/render/p3.png' })],
    OPTIONS,
  );
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.equal(chunk.imagePath, '/render/p3.png');
});
