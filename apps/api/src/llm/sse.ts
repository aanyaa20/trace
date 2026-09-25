/**
 * Incremental SSE parsing for the `/chat/completions` stream.
 *
 * Pure and config-free so it can be tested without a network or an
 * environment, which is the same reason ipRules.ts and searchParse.ts were made
 * config-free: a unit test of a frame parser should not need a DATABASE_URL.
 *
 * The subtlety worth testing is that a frame can arrive split across two reads.
 * Anything after the last frame separator is returned as `rest` and carried
 * into the next call rather than parsed, because parsing half a frame silently
 * drops a token.
 */
export interface SseScan {
  /** Content deltas, in order, ready to emit. */
  deltas: string[];
  /** The incomplete tail to carry into the next read. */
  rest: string;
  /** True once the server sent [DONE]; nothing after it matters. */
  done: boolean;
}

interface ChatCompletionChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
}

export function scanSse(buffer: string): SseScan {
  const frames = buffer.split('\n\n');
  const rest = frames.pop() ?? '';
  const deltas: string[] = [];

  for (const frame of frames) {
    const line = frame.split('\n').find((candidate) => candidate.startsWith('data:'));
    if (!line) continue;

    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return { deltas, rest: '', done: true };
    if (!payload) continue;

    let chunk: ChatCompletionChunk;
    try {
      chunk = JSON.parse(payload) as ChatCompletionChunk;
    } catch {
      // A malformed frame is skipped rather than thrown: one bad frame should
      // not discard an answer that is otherwise streaming fine.
      continue;
    }

    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) deltas.push(delta);
  }

  return { deltas, rest, done: false };
}
