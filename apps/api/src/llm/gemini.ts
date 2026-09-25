import { GoogleGenAI } from '@google/genai';
import type { ZodType } from 'zod';
import { env } from '../env.js';
import { TokenBucket, isDailyQuotaExhausted, withRetry } from './rateLimiter.js';
import { LLMError, type GenerateOptions, type LLMProvider } from './types.js';

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function isRetryable(error: unknown): boolean {
  if (isDailyQuotaExhausted(error)) return false;
  if (error instanceof LLMError) return error.retryable;
  const status = (error as { status?: number })?.status;
  if (typeof status === 'number') return RETRYABLE_STATUS.has(status);
  return /429|quota|rate limit|unavailable|deadline/i.test(String(error));
}

/** Strips ```json fences some models still emit despite JSON mode. */
function unwrapJson(raw: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(raw);
  return (fenced?.[1] ?? raw).trim();
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  readonly model: string;

  private readonly client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  // The free-tier quota is enforced per model, so each provider instance keeps
  // its own bucket. A shared one would make grading and synthesis compete for
  // a budget they do not actually share.
  private readonly bucket: TokenBucket;

  constructor(model: string = env.GEMINI_MODEL) {
    this.model = model;
    this.bucket = new TokenBucket(Math.min(2, env.LLM_RPM), env.LLM_RPM);
  }

  async generate(prompt: string, options: GenerateOptions = {}): Promise<string> {
    await this.bucket.acquire(options.signal);

    return withRetry(
      async () => {
        const response = await this.client.models.generateContent({
          model: this.model,
          contents: prompt,
          config: {
            ...(options.system ? { systemInstruction: options.system } : {}),
            temperature: options.temperature ?? 0.2,
            ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
            ...(options.signal ? { abortSignal: options.signal } : {}),
          },
        });

        const text = response.text;
        if (!text) throw new LLMError(this.name, 'model returned an empty completion', true);
        return text;
      },
      env.LLM_MAX_RETRIES,
      isRetryable,
      options.signal,
    );
  }

  async generateStructured<T>(
    prompt: string,
    schema: ZodType<T>,
    schemaHint: string,
    options: GenerateOptions = {},
  ): Promise<T> {
    const instruction = `${prompt}\n\nReturn JSON matching exactly this shape, with no prose:\n${schemaHint}`;
    const raw = await this.generateJson(instruction, options);

    const first = schema.safeParse(raw.parsed);
    if (first.success) return first.data;

    // One repair attempt: models usually fix a shape error when shown the
    // validation message, and this is far cheaper than failing the request.
    const repairPrompt = [
      instruction,
      `\nYour previous reply was rejected: ${first.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      `Previous reply:\n${raw.text.slice(0, 2000)}`,
      'Return only corrected JSON.',
    ].join('\n');

    const repaired = await this.generateJson(repairPrompt, options);
    const second = schema.safeParse(repaired.parsed);
    if (second.success) return second.data;

    throw new LLMError(
      this.name,
      `structured output failed validation twice: ${second.error.issues.map((i) => i.message).join('; ')}`,
      false,
    );
  }

  private async generateJson(
    prompt: string,
    options: GenerateOptions,
  ): Promise<{ parsed: unknown; text: string }> {
    await this.bucket.acquire(options.signal);

    return withRetry(
      async () => {
        const response = await this.client.models.generateContent({
          model: this.model,
          contents: prompt,
          config: {
            ...(options.system ? { systemInstruction: options.system } : {}),
            temperature: options.temperature ?? 0,
            responseMimeType: 'application/json',
            ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
            ...(options.signal ? { abortSignal: options.signal } : {}),
          },
        });

        const text = response.text;
        if (!text) throw new LLMError(this.name, 'model returned an empty completion', true);

        try {
          return { parsed: JSON.parse(unwrapJson(text)) as unknown, text };
        } catch {
          throw new LLMError(this.name, 'model returned malformed JSON', true);
        }
      },
      env.LLM_MAX_RETRIES,
      isRetryable,
      options.signal,
    );
  }

  async *stream(prompt: string, options: GenerateOptions = {}): AsyncIterable<string> {
    await this.bucket.acquire(options.signal);

    // A partially streamed answer cannot be retried without replaying tokens
    // the client already rendered, so only stream setup is retried.
    const iterator = await withRetry(
      () =>
        this.client.models.generateContentStream({
          model: this.model,
          contents: prompt,
          config: {
            ...(options.system ? { systemInstruction: options.system } : {}),
            temperature: options.temperature ?? 0.2,
            ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
            ...(options.signal ? { abortSignal: options.signal } : {}),
          },
        }),
      env.LLM_MAX_RETRIES,
      isRetryable,
      options.signal,
    );

    for await (const chunk of iterator) {
      if (options.signal?.aborted) return;
      const text = chunk.text;
      if (text) yield text;
    }
  }
}
