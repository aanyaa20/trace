import type { RetrievedChunk } from '@trace/contracts';
import { env } from '../../env.js';
import { toError } from '../../errors.js';
import type { AgentContext, AgentState } from '../state.js';
import {
  MAX_RESULTS,
  isBotCheckPage,
  parseDuckDuckGo,
  type ExternalResult,
} from './searchParse.js';

const TIMEOUT_MS = 12_000;

interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

async function tavily(query: string, signal: AbortSignal): Promise<ExternalResult[]> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query,
      max_results: MAX_RESULTS,
      search_depth: 'basic',
    }),
    signal,
  });

  if (!response.ok) throw new Error(`tavily returned ${response.status}`);
  const body = (await response.json()) as TavilyResponse;
  return (body.results ?? []).map((result) => ({
    title: result.title ?? result.url ?? 'untitled',
    url: result.url ?? '',
    snippet: (result.content ?? '').slice(0, 1200),
  }));
}


async function duckduckgo(query: string, signal: AbortSignal): Promise<ExternalResult[]> {
  const response = await fetch('https://lite.duckduckgo.com/lite/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // A non-browser user agent is served a bot-check page with a 202 and no
      // results, which looks identical to "nothing matched".
      'user-agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal,
  });

  if (!response.ok) throw new Error(`duckduckgo returned ${response.status}`);
  const html = await response.text();

  if (isBotCheckPage(html)) {
    throw new Error('duckduckgo served a bot-check page instead of results');
  }

  return parseDuckDuckGo(html);
}

/**
 * Last resort before abstaining. Results are tagged external and carry their
 * URL, so the UI can mark them as outside the corpus; the promise this system
 * makes is that corpus answers are grounded in the corpus, not that it never
 * looks anything up.
 */
export async function webSearch(state: AgentState, ctx: AgentContext): Promise<AgentState> {
  const stage = ctx.bus.begin('web_search', state.iteration);
  const query = state.analysis?.rewrites[0] ?? state.userQuery;

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  ctx.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, TIMEOUT_MS);

  try {
    const found =
      env.WEB_SEARCH_PROVIDER === 'tavily'
        ? await tavily(query, controller.signal)
        : await duckduckgo(query, controller.signal);

    const external: RetrievedChunk[] = found
      .filter((result) => result.snippet.trim().length > 0)
      .map((result, index) => ({
        chunkId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        documentId: '00000000-0000-4000-8000-000000000000',
        filename: result.title,
        modality: 'text' as const,
        source: 'text' as const,
        text: result.snippet,
        score: 0.5,
        page: null,
        charStart: null,
        charEnd: null,
        tsStart: null,
        tsEnd: null,
        imagePath: null,
        external: true,
        externalUrl: result.url,
      }));

    stage.complete({ stage: 'web_search', query, results: external });
    return { ...state, external, webSearched: true };
  } catch (cause) {
    stage.fail(`web search failed: ${toError(cause).message}`);
    return { ...state, webSearched: true };
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', abort);
  }
}
