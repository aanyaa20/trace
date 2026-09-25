import type { ZodType } from 'zod';

export interface GenerateOptions {
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Aborts the upstream request when the client disconnects mid-stream. */
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;

  generate(prompt: string, options?: GenerateOptions): Promise<string>;

  /**
   * Returns a value already validated against `schema`. Implementations ask
   * for JSON mode, parse, and repair once before giving up, so callers never
   * see a half-parsed object.
   */
  generateStructured<T>(
    prompt: string,
    schema: ZodType<T>,
    schemaHint: string,
    options?: GenerateOptions,
  ): Promise<T>;

  stream(prompt: string, options?: GenerateOptions): AsyncIterable<string>;
}

export class LLMError extends Error {
  readonly provider: string;
  readonly retryable: boolean;

  constructor(provider: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'LLMError';
    this.provider = provider;
    this.retryable = retryable;
  }
}
