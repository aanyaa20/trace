import type { BlockSource, ExtractBlock } from '@trace/contracts';

export interface PlannedChunk {
  ordinal: number;
  kind: 'text' | 'image';
  source: BlockSource;
  text: string;
  page: number | null;
  /** Offsets into the source block's text, so a citation resolves to an exact
   *  span on an exact page. Null where the chunk spans several blocks. */
  charStart: number | null;
  charEnd: number | null;
  tsStart: number | null;
  tsEnd: number | null;
  imagePath: string | null;
}

export interface ChunkOptions {
  targetChars: number;
  overlapChars: number;
}

/**
 * Splitting on sentence ends rather than a fixed window keeps a cited span
 * from beginning mid-clause. The lookbehind excludes the common abbreviations
 * that would otherwise split "Fig. 3" or "et al." into separate chunks.
 */
const SENTENCE_BOUNDARY =
  /(?<!\b(?:[A-Z]|Fig|fig|Eq|eq|No|no|Vol|vol|vs|etc|al|ie|eg|Dr|Mr|Mrs|Ms|Prof|St|approx)\.)(?<=[.!?])\s+(?=[^a-z])/g;

export function splitSentences(text: string): string[] {
  const normalised = text.replace(/\r\n/g, '\n');
  const parts = normalised.split(SENTENCE_BOUNDARY).filter((part) => part.trim().length > 0);
  return parts.length > 0 ? parts : normalised.trim().length > 0 ? [normalised] : [];
}

/**
 * Whether adjacent blocks may be merged into one chunk.
 *
 * Transcript segments must merge: a whisper segment is a few seconds of speech
 * and would otherwise produce chunks too small to retrieve on, and merging is
 * lossless because the timestamp span simply widens.
 *
 * Pages must not merge. A chunk spanning two pages has no single page number,
 * and page attribution is the thing being promised.
 */
function canMerge(a: ExtractBlock, b: ExtractBlock): boolean {
  if (a.kind !== 'text' || b.kind !== 'text') return false;
  if (a.source !== b.source) return false;
  if (a.source !== 'asr') return false;
  return a.page === b.page;
}

/** Trailing sentences totalling at most `overlapChars`, carried into the next
 *  chunk so a claim split across a boundary is still retrievable. */
function overlapTail(sentences: string[], overlapChars: number): string[] {
  if (overlapChars <= 0) return [];
  const tail: string[] = [];
  let size = 0;
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const sentence = sentences[i]!;
    if (size + sentence.length > overlapChars && tail.length > 0) break;
    tail.unshift(sentence);
    size += sentence.length;
  }
  // Never carry the whole chunk forward, or the splitter cannot advance.
  return tail.length === sentences.length ? tail.slice(1) : tail;
}

interface Emitter {
  push(chunk: Omit<PlannedChunk, 'ordinal'>): void;
}

function splitBlockText(block: ExtractBlock, options: ChunkOptions, emit: Emitter): void {
  const text = block.text;
  if (text.trim().length === 0) return;

  const sentences = splitSentences(text);
  let cursor = 0;
  let buffer: string[] = [];
  let bufferStart = 0;
  let bufferLength = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const joined = buffer.join(' ').trim();
    if (joined.length === 0) return;

    emit.push({
      kind: 'text',
      source: block.source,
      text: joined,
      page: block.page,
      charStart: bufferStart,
      charEnd: Math.min(bufferStart + joined.length, text.length),
      tsStart: block.tsStart,
      tsEnd: block.tsEnd,
      imagePath: block.imagePath,
    });
  };

  for (const sentence of sentences) {
    // Locate the sentence in the original text so offsets survive the join,
    // which normalises the whitespace between sentences.
    const found = text.indexOf(sentence.trim(), cursor);
    const start = found >= 0 ? found : cursor;
    cursor = start + sentence.trim().length;

    if (buffer.length === 0) bufferStart = start;

    buffer.push(sentence.trim());
    bufferLength += sentence.trim().length;

    if (bufferLength >= options.targetChars) {
      flush();
      const tail = overlapTail(buffer, options.overlapChars);
      buffer = tail;
      bufferLength = tail.reduce((sum, part) => sum + part.length, 0);
      bufferStart = tail.length > 0 ? Math.max(0, cursor - bufferLength) : cursor;
    }
  }

  flush();
}

function mergeRun(blocks: ExtractBlock[], options: ChunkOptions, emit: Emitter): void {
  let buffer: ExtractBlock[] = [];
  let size = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const first = buffer[0]!;
    const last = buffer[buffer.length - 1]!;
    const text = buffer.map((block) => block.text.trim()).join(' ').trim();
    if (text.length > 0) {
      emit.push({
        kind: 'text',
        source: first.source,
        text,
        page: first.page,
        // Offsets would point into a concatenation that exists nowhere on
        // disk; the timestamp span is the locator for transcript chunks.
        charStart: null,
        charEnd: null,
        tsStart: first.tsStart,
        tsEnd: last.tsEnd,
        imagePath: null,
      });
    }
    buffer = [];
    size = 0;
  };

  for (const block of blocks) {
    if (size > 0 && size + block.text.length > options.targetChars) flush();
    buffer.push(block);
    size += block.text.length;
  }
  flush();
}

/**
 * Turns extraction blocks into chunks. Image blocks pass through untouched so
 * their vector stays tied to one file on disk; text blocks are merged or split
 * according to what preserves their locator.
 */
export function planChunks(blocks: ExtractBlock[], options: ChunkOptions): PlannedChunk[] {
  const planned: Array<Omit<PlannedChunk, 'ordinal'>> = [];
  const emit: Emitter = { push: (chunk) => planned.push(chunk) };

  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index]!;

    if (block.kind === 'image') {
      planned.push({
        kind: 'image',
        source: block.source,
        text: block.text,
        page: block.page,
        charStart: null,
        charEnd: null,
        tsStart: block.tsStart,
        tsEnd: block.tsEnd,
        imagePath: block.imagePath,
      });
      index += 1;
      continue;
    }

    const run: ExtractBlock[] = [block];
    let next = index + 1;
    while (next < blocks.length && canMerge(block, blocks[next]!)) {
      run.push(blocks[next]!);
      next += 1;
    }

    if (run.length > 1) {
      mergeRun(run, options, emit);
    } else if (block.text.length > options.targetChars) {
      splitBlockText(block, options, emit);
    } else if (block.text.trim().length > 0) {
      planned.push({
        kind: 'text',
        source: block.source,
        text: block.text.trim(),
        page: block.page,
        charStart: 0,
        charEnd: block.text.length,
        tsStart: block.tsStart,
        tsEnd: block.tsEnd,
        imagePath: block.imagePath,
      });
    }

    index = next;
  }

  return planned.map((chunk, ordinal) => ({ ...chunk, ordinal }));
}
