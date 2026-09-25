/**
 * Pure parsing for web-search responses. Kept apart from webSearch.ts, which
 * reads configuration and performs network calls, so the parsing can be tested
 * on captured markup without a database URL or an API key.
 */

export interface ExternalResult {
  title: string;
  url: string;
  snippet: string;
}

export const MAX_RESULTS = 4;

export function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// The markup quotes attributes with single quotes and puts href before class,
// so both patterns accept either quote style and any attribute order.
const LINK_PATTERN = /<a[^>]*href=["']([^"']+)["'][^>]*class=["']result-link["'][^>]*>([\s\S]*?)<\/a>/g;
const SNIPPET_PATTERN = /<td[^>]*class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/g;

export function parseDuckDuckGo(html: string): ExternalResult[] {
  const snippets = [...html.matchAll(SNIPPET_PATTERN)].map((match) => stripTags(match[1] ?? ''));

  const results: ExternalResult[] = [];
  let index = 0;
  for (const match of html.matchAll(LINK_PATTERN)) {
    if (results.length >= MAX_RESULTS) break;
    const url = decodeEntities(match[1] ?? '');
    const title = stripTags(match[2] ?? '');
    if (url.startsWith('http')) {
      results.push({ title: title || url, url, snippet: snippets[index] ?? '' });
    }
    index += 1;
  }
  return results;
}

/** DuckDuckGo answers a non-browser client with a bot-check page and a 202,
 *  which is otherwise indistinguishable from "nothing matched". */
export function isBotCheckPage(html: string): boolean {
  return html.includes('anomaly-modal');
}
