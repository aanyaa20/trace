import type { ZodType } from 'zod';
import { logger } from '../logger.js';
import { isDailyQuotaExhausted } from './rateLimiter.js';
import type { GenerateOptions, LLMProvider } from './types.js';

/**
 * Shared across every provider pair in the process. A daily quota belongs to
 * the API key, not to one model, so grading discovering the wall should not
 * leave synthesis to rediscover it a second later at the cost of another
 * failed request.
 */
class Breaker {
  private trippedAt: number | null = null;

  constructor(private readonly cooldownMs: number) {}

  get open(): boolean {
    if (this.trippedAt === null) return false;
    // Half-open after the cooldown: the next call probes the primary again
    // rather than waiting for a restart. A daily allowance does come back, and
    // guessing which timezone it resets in would be worse than probing.
    if (Date.now() - this.trippedAt >= this.cooldownMs) {
      this.trippedAt = null;
      return false;
    }
    return true;
  }

  trip(): void {
    this.trippedAt = Date.now();
  }
}

let shared: Breaker | null = null;

export function quotaBreaker(cooldownMs: number): Breaker {
  shared ??= new Breaker(cooldownMs);
  return shared;
}

/** Test seam: the breaker is process-wide state. */
export function resetQuotaBreaker(): void {
  shared = null;
}

/**
 * Routes to a local model once the hosted provider's daily quota is gone.
 *
 * The distinction the rate limiter already makes is the one that matters here:
 * a per-minute 429 is waited out, because it clears on its own, and only a
 * per-day exhaustion trips the breaker, because waiting cannot clear a daily
 * allowance. Falling back on any 429 would abandon the better model over a
 * delay of a few seconds.
 *
 * Degrading is the point. An answer from a small local model, still grounded
 * and still cited, is worth more than a quota error — and every guarantee the
 * system makes survives the switch, because verification happens after
 * synthesis regardless of what produced the text.
 */
export class FallbackProvider implements LLMProvider {
  readonly model: string;
  private readonly breaker: Breaker;

  constructor(
    private readonly primary: LLMProvider,
    private readonly fallback: LLMProvider,
    cooldownMs: number,
  ) {
    this.model = `${primary.model} → ${fallback.model}`;
    this.breaker = quotaBreaker(cooldownMs);
  }

  /** Reports which provider would actually serve, so an error names the
   *  model that produced it rather than the one that was configured. */
  get name(): string {
    return this.breaker.open ? this.fallback.name : this.primary.name;
  }

  private active(): LLMProvider {
    return this.breaker.open ? this.fallback : this.primary;
  }

  private async attempt<T>(run: (provider: LLMProvider) => Promise<T>): Promise<T> {
    if (this.breaker.open) return run(this.fallback);

    try {
      return await run(this.primary);
    } catch (cause) {
      if (!isDailyQuotaExhausted(cause)) throw cause;

      this.breaker.trip();
      logger.warn(
        { primary: this.primary.name, fallback: this.fallback.name, model: this.fallback.model },
        'daily quota exhausted; falling back to the local model',
      );
      return run(this.fallback);
    }
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<string> {
    return this.attempt((provider) => provider.generate(prompt, options));
  }

  async generateStructured<T>(
    prompt: string,
    schema: ZodType<T>,
    schemaHint: string,
    options?: GenerateOptions,
  ): Promise<T> {
    return this.attempt((provider) =>
      provider.generateStructured(prompt, schema, schemaHint, options),
    );
  }

  /**
   * Streaming cannot fall back mid-flight: tokens already sent cannot be
   * withdrawn, and replaying them from a different model would contradict what
   * the reader has seen. The provider is therefore chosen before the first
   * token, and a quota failure during setup trips the breaker for the calls
   * that follow rather than rescuing this one.
   */
  async *stream(prompt: string, options?: GenerateOptions): AsyncIterable<string> {
    const provider = this.active();
    try {
      yield* provider.stream(prompt, options);
    } catch (cause) {
      if (provider !== this.fallback && isDailyQuotaExhausted(cause)) this.breaker.trip();
      throw cause;
    }
  }
}
