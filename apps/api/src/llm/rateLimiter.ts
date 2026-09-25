import { LLMError } from './types.js';

/**
 * Token bucket over a sliding minute. The Gemini free tier rejects bursts
 * outright, and a demo that dies on a 429 mid-answer is worse than one that
 * waits 800ms, so callers queue instead of failing.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMinute: number,
  ) {
    this.tokens = capacity;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMinutes = (now - this.lastRefill) / 60_000;
    if (elapsedMinutes <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMinutes * this.refillPerMinute);
    this.lastRefill = now;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new LLMError('rate-limiter', 'request aborted while queued', false);
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - this.tokens) * (60_000 / this.refillPerMinute));
      await sleep(Math.min(waitMs, 5_000), signal);
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new LLMError('rate-limiter', 'aborted while backing off', false));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A 429 from Gemini carries the wait the server actually wants, either as a
 * RetryInfo block or in the message itself. Guessing an exponential delay when
 * the service has already said "retry in 40s" just burns the remaining
 * attempts early and fails anyway.
 */
/**
 * A per-day quota is not a rate limit you can wait out inside one request. The
 * service still answers with a retryDelay, so honouring it blindly costs a
 * minute per attempt and fails anyway.
 */
export function isDailyQuotaExhausted(error: unknown): boolean {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /PerDay|RequestsPerDay/i.test(text);
}

export function serverRequestedDelayMs(error: unknown): number | null {
  const text =
    error instanceof Error ? `${error.message}` : typeof error === 'string' ? error : '';
  if (!text) return null;

  const retryInfo = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text);
  if (retryInfo?.[1]) return Math.ceil(Number(retryInfo[1]) * 1000);

  const prose = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(text);
  if (prose?.[1]) return Math.ceil(Number(prose[1]) * 1000);

  return null;
}

const MAX_BACKOFF_MS = 60_000;

/** Server-directed delay when one is offered, otherwise exponential backoff
 *  with full jitter so parallel graders do not resynchronise. */
export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number,
  isRetryable: (error: unknown) => boolean,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation();
    } catch (cause) {
      lastError = cause;
      if (attempt === maxRetries || !isRetryable(cause)) break;

      // Waiting cannot clear a daily allowance; fail now and say why.
      if (isDailyQuotaExhausted(cause)) break;

      const requested = serverRequestedDelayMs(cause);
      const delay =
        requested !== null
          ? Math.min(requested + 250, MAX_BACKOFF_MS)
          : Math.random() * Math.min(30_000, 500 * 2 ** attempt);

      await sleep(delay, signal);
    }
  }

  throw lastError;
}
