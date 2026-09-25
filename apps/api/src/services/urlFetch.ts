import { badRequest, upstreamFailure } from '../errors.js';
import { env } from '../env.js';
import { assertPublicUrl } from './ssrf.js';

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 20_000;

const ALLOWED_CONTENT_TYPES = new Set([
  'text/html',
  'text/plain',
  'text/markdown',
  'application/pdf',
]);

export interface FetchedUrl {
  finalUrl: string;
  contentType: string;
  body: Buffer;
}

/**
 * Fetches a public URL with the redirect chain validated hop by hop. Node's
 * fetch follows redirects internally with no hook, so redirects are handled
 * manually and each Location is revalidated before it is followed.
 */
export async function fetchPublicUrl(rawUrl: string): Promise<FetchedUrl> {
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(currentUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'trace-ingest/0.1', accept: '*/*' },
      });
    } catch (cause) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw upstreamFailure('url_fetch', `${currentUrl} timed out after ${FETCH_TIMEOUT_MS}ms`);
      }
      throw upstreamFailure('url_fetch', `could not fetch ${currentUrl}: ${String(cause)}`);
    }
    clearTimeout(timer);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw upstreamFailure('url_fetch', `${currentUrl} returned ${response.status} without a location header`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (!response.ok) {
      throw upstreamFailure('url_fetch', `${currentUrl} returned ${response.status}`);
    }

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      throw badRequest(`unsupported content type for URL ingestion: ${contentType || 'unknown'}`);
    }

    return {
      finalUrl: currentUrl,
      contentType,
      body: await readBounded(response, env.MAX_URL_BYTES, currentUrl),
    };
  }

  throw badRequest(`too many redirects while fetching ${rawUrl}`);
}

/**
 * Reads the body incrementally and aborts past the limit. Content-Length is
 * advisory and absent on chunked responses, so the cap is enforced against
 * bytes actually received.
 */
async function readBounded(response: Response, limit: number, url: string): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > limit) {
    throw badRequest(`${url} declares ${declared} bytes, over the ${limit} byte limit`);
  }

  if (!response.body) {
    throw upstreamFailure('url_fetch', `${url} returned an empty body`);
  }

  const chunks: Buffer[] = [];
  let total = 0;

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        throw badRequest(`${url} exceeds the ${limit} byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return Buffer.concat(chunks);
}
