import type { ZodType } from 'zod';
import { env } from '../env.js';
import { withRetry } from './rateLimiter.js';
import { LLMError, type GenerateOptions, type LLMProvider } from './types.js';

/** Strips ```json fences small models emit even when asked for raw JSON. */
function unwrapJson(raw: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(raw);
  return (fenced?.[1] ?? raw).trim();
}

function isRetryable(error: unknown): boolean {
  if (error instanceof LLMError) return error.retryable;
  // A cold model is loaded on first request and the call can time out while
  // weights page in; that is worth one more attempt.
  return /ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|loading/i.test(String(error));
}

interface OllamaChunk {
  response?: string;
  done?: boolean;
  error?: string;
}

/**
 * A local model over Ollama, used as the fallback when the hosted provider's
 * daily quota is gone.
 *
 * There is no rate limiter here on purpose. The constraint this exists to
 * answer is a quota, and a local model has none — it has a queue. Adding a
 * token bucket would throttle the one path that is not metered.
 */
export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  readonly model: string;

  constructor(model: string = env.OLLAMA_MODEL) {
    this.model = model;
  }

  private async call(
    prompt: string,
    options: GenerateOptions,
    json: boolean,
  ): Promise<string> {
    const response = await fetch(`${env.OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(options.signal ? { signal: options.signal } : {}),
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        ...(json ? { format: 'json' } : {}),
        ...(options.system ? { system: options.system } : {}),
        options: {
          temperature: options.temperature ?? 0.2,
          ...(options.maxOutputTokens ? { num_predict: options.maxOutputTokens } : {}),
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new LLMError(
        this.name,
        `ollama returned ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`,
        response.status >= 500,
      );
    }

    const body = (await response.json()) as OllamaChunk;
    if (body.error) throw new LLMError(this.name, body.error, false);
    const text = body.response ?? '';
    if (!text.trim()) throw new LLMError(this.name, 'model returned an empty completion', true);
    return text;
  }

  async generate(prompt: string, options: GenerateOptions = {}): Promise<string> {
    return withRetry(
      () => this.call(prompt, options, false),
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

    const first = await withRetry(
      () => this.call(instruction, options, true),
      env.LLM_MAX_RETRIES,
      isRetryable,
      options.signal,
    );

    const parsed = schema.safeParse(safeParseJson(first));
    if (parsed.success) return parsed.data;

    // One repair attempt, the same policy the hosted providers use. A small
    // local model gets the shape wrong more often, which is exactly why the
    // repair pass matters more here rather than less.
    const repairPrompt = [
      instruction,
      '',
      'Your previous reply did not match the shape. It was:',
      first.slice(0, 2000),
      '',
      `The error was: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      'Reply with corrected JSON only.',
    ].join('\n');

    const second = await withRetry(
      () => this.call(repairPrompt, options, true),
      env.LLM_MAX_RETRIES,
      isRetryable,
      options.signal,
    );

    const repaired = schema.safeParse(safeParseJson(second));
    if (repaired.success) return repaired.data;

    throw new LLMError(
      this.name,
      `model did not produce the requested shape: ${repaired.error.issues.map((issue) => issue.message).join('; ')}`,
      false,
    );
  }

  async *stream(prompt: string, options: GenerateOptions = {}): AsyncIterable<string> {
    const response = await fetch(`${env.OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(options.signal ? { signal: options.signal } : {}),
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: true,
        ...(options.system ? { system: options.system } : {}),
        options: {
          temperature: options.temperature ?? 0.2,
          ...(options.maxOutputTokens ? { num_predict: options.maxOutputTokens } : {}),
        },
      }),
    });

    if (!response.ok || !response.body) {
      throw new LLMError(this.name, `ollama returned ${response.status}`, response.status >= 500);
    }

    // NDJSON: one JSON object per line, and a line can arrive split across
    // chunks, so the tail is carried over rather than parsed.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        let chunk: OllamaChunk;
        try {
          chunk = JSON.parse(line) as OllamaChunk;
        } catch {
          continue;
        }
        if (chunk.error) throw new LLMError(this.name, chunk.error, false);
        if (chunk.response) yield chunk.response;
      }
    }
  }
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(unwrapJson(raw));
  } catch {
    return null;
  }
}

/** Whether the local model is reachable, for /readyz and for a clear error
 *  when the fallback is configured but nothing is listening. */
export async function ollamaAvailable(signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`${env.OLLAMA_URL}/api/tags`, {
      ...(signal ? { signal } : {}),
    });
    return response.ok;
  } catch {
    return false;
  }
}
