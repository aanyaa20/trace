import type { ZodType } from 'zod';
import { env } from '../env.js';
import { TokenBucket, withRetry } from './rateLimiter.js';
import { scanSse } from './sse.js';
import { LLMError, type GenerateOptions, type LLMProvider } from './types.js';

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export interface OpenAICompatibleConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Requests per minute this endpoint allows. */
  rpm: number;
}

interface ChatCompletionResponse {
  choices: Array<{ message?: { content?: string | null } }>;
}

function buildMessages(prompt: string, system?: string): Array<{ role: string; content: string }> {
  return system
    ? [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ]
    : [{ role: 'user', content: prompt }];
}

/** Strips ```json fences some models emit despite JSON mode. */
function unwrapJson(raw: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(raw);
  return (fenced?.[1] ?? raw).trim();
}

/**
 * The `/chat/completions` shape, which OpenAI defined and several providers
 * now serve. Implemented against the REST API directly rather than through a
 * vendor SDK, so adding a provider that speaks it is configuration rather than
 * a dependency.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;

  private readonly config: OpenAICompatibleConfig;
  private readonly bucket: TokenBucket;

  constructor(config: OpenAICompatibleConfig) {
    this.config = config;
    this.name = config.name;
    this.model = config.model;
    this.bucket = new TokenBucket(Math.min(2, config.rpm), config.rpm);
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, ...body }),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new LLMError(
        this.name,
        `chat/completions returned ${response.status}: ${detail}`,
        RETRYABLE_STATUS.has(response.status),
      );
    }

    return response;
  }

  private async chat(
    messages: Array<{ role: string; content: string }>,
    options: GenerateOptions,
    jsonMode: boolean,
  ): Promise<string> {
    await this.bucket.acquire(options.signal);

    return withRetry(
      async () => {
        const response = await this.post(
          {
            messages,
            temperature: options.temperature ?? 0.2,
            ...(options.maxOutputTokens ? { max_tokens: options.maxOutputTokens } : {}),
            ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
          },
          options.signal,
        );

        const body = (await response.json()) as ChatCompletionResponse;
        const content = body.choices[0]?.message?.content;
        if (!content) throw new LLMError(this.name, 'model returned an empty completion', true);
        return content;
      },
      env.LLM_MAX_RETRIES,
      (error) => error instanceof LLMError && error.retryable,
      options.signal,
    );
  }

  generate(prompt: string, options: GenerateOptions = {}): Promise<string> {
    return this.chat(buildMessages(prompt, options.system), options, false);
  }

  async generateStructured<T>(
    prompt: string,
    schema: ZodType<T>,
    schemaHint: string,
    options: GenerateOptions = {},
  ): Promise<T> {
    const instruction = `${prompt}\n\nReturn JSON matching exactly this shape, with no prose:\n${schemaHint}`;
    const first = await this.chat(buildMessages(instruction, options.system), options, true);

    const parsed = schema.safeParse(safeParseJson(first));
    if (parsed.success) return parsed.data;

    // One repair attempt, the same policy the Gemini provider uses. Models
    // usually fix a shape error when shown the error, and a second request is
    // cheaper than failing the whole answer.
    const repairPrompt = [
      instruction,
      '',
      'Your previous reply did not match the shape. It was:',
      first.slice(0, 2000),
      '',
      `The error was: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      'Reply with corrected JSON only.',
    ].join('\n');

    const second = await this.chat(buildMessages(repairPrompt, options.system), options, true);
    const repaired = schema.safeParse(safeParseJson(second));
    if (repaired.success) return repaired.data;

    throw new LLMError(
      this.name,
      `structured output failed validation: ${repaired.error.issues.map((issue) => issue.message).join('; ')}`,
      false,
    );
  }

  /**
   * Real token-level streaming over SSE. The synthesis path streams to the
   * browser, so yielding one completed block instead would turn a live answer
   * into a long pause followed by a wall of text.
   */
  async *stream(prompt: string, options: GenerateOptions = {}): AsyncIterable<string> {
    await this.bucket.acquire(options.signal);

    // Only stream setup is retried: a partially streamed answer cannot be
    // retried without replaying tokens the client has already rendered.
    const response = await withRetry(
      () =>
        this.post(
          {
            messages: buildMessages(prompt, options.system),
            temperature: options.temperature ?? 0.2,
            ...(options.maxOutputTokens ? { max_tokens: options.maxOutputTokens } : {}),
            stream: true,
          },
          options.signal,
        ),
      env.LLM_MAX_RETRIES,
      (error) => error instanceof LLMError && error.retryable,
      options.signal,
    );

    if (!response.body) throw new LLMError(this.name, 'stream had no body', true);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const scan = scanSse(buffer);
      buffer = scan.rest;

      for (const delta of scan.deltas) yield delta;
      if (scan.done) return;
    }
  }
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(unwrapJson(raw)) as unknown;
  } catch {
    return null;
  }
}
