import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { FallbackProvider, resetQuotaBreaker } from './fallback.js';
import { LLMError, type GenerateOptions, type LLMProvider } from './types.js';

class Stub implements LLMProvider {
  calls = 0;
  constructor(
    readonly name: string,
    readonly model: string,
    private readonly fail?: () => Error,
  ) {}

  async generate(prompt: string, _options?: GenerateOptions): Promise<string> {
    this.calls += 1;
    if (this.fail) throw this.fail();
    return `${this.name}:${prompt}`;
  }

  async generateStructured<T>(_p: string, schema: z.ZodType<T>): Promise<T> {
    this.calls += 1;
    if (this.fail) throw this.fail();
    return schema.parse({ ok: true });
  }

  async *stream(prompt: string): AsyncIterable<string> {
    this.calls += 1;
    if (this.fail) throw this.fail();
    yield `${this.name}:${prompt}`;
  }
}

const dailyQuota = (): Error =>
  new Error('429 RESOURCE_EXHAUSTED quota metric GenerateRequestsPerDayPerProjectPerModel');
const perMinute = (): Error => new Error('429 RESOURCE_EXHAUSTED requests per minute');

test('the primary serves while it has quota', async () => {
  resetQuotaBreaker();
  const primary = new Stub('gemini', 'flash');
  const fallback = new Stub('ollama', 'qwen');
  const provider = new FallbackProvider(primary, fallback, 60_000);

  assert.equal(await provider.generate('hello'), 'gemini:hello');
  assert.equal(fallback.calls, 0);
  assert.equal(provider.name, 'gemini');
});

test('a per-day exhaustion falls back and answers', async () => {
  resetQuotaBreaker();
  const primary = new Stub('gemini', 'flash', dailyQuota);
  const fallback = new Stub('ollama', 'qwen');
  const provider = new FallbackProvider(primary, fallback, 60_000);

  assert.equal(await provider.generate('hello'), 'ollama:hello');
  assert.equal(provider.name, 'ollama');
});

test('once tripped the primary is not called again during the cooldown', async () => {
  resetQuotaBreaker();
  const primary = new Stub('gemini', 'flash', dailyQuota);
  const fallback = new Stub('ollama', 'qwen');
  const provider = new FallbackProvider(primary, fallback, 60_000);

  await provider.generate('one');
  await provider.generate('two');
  await provider.generate('three');

  // One probe, then every later call goes straight to the local model rather
  // than paying for a request that is certain to fail.
  assert.equal(primary.calls, 1);
  assert.equal(fallback.calls, 3);
});

test('a per-minute 429 is not a fallback condition', async () => {
  resetQuotaBreaker();
  const primary = new Stub('gemini', 'flash', perMinute);
  const fallback = new Stub('ollama', 'qwen');
  const provider = new FallbackProvider(primary, fallback, 60_000);

  // It clears on its own; abandoning the better model over a few seconds of
  // delay would be the wrong trade.
  await assert.rejects(() => provider.generate('hello'), /per minute/);
  assert.equal(fallback.calls, 0);
});

test('the breaker half-opens once the cooldown has passed', async () => {
  resetQuotaBreaker();
  const primary = new Stub('gemini', 'flash', dailyQuota);
  const fallback = new Stub('ollama', 'qwen');
  const provider = new FallbackProvider(primary, fallback, 0);

  await provider.generate('one');
  await provider.generate('two');
  assert.equal(primary.calls, 2, 'a zero cooldown probes the primary on every call');
});

test('the breaker is shared, so one path does not rediscover the wall', async () => {
  resetQuotaBreaker();
  const synthesis = new Stub('gemini', 'flash', dailyQuota);
  const grading = new Stub('gemini', 'lite', dailyQuota);
  const local = new Stub('ollama', 'qwen');

  const a = new FallbackProvider(synthesis, local, 60_000);
  const b = new FallbackProvider(grading, local, 60_000);

  await a.generate('first');
  await b.generate('second');

  assert.equal(synthesis.calls, 1);
  assert.equal(grading.calls, 0, 'the second pair inherits the tripped breaker');
});

test('structured generation falls back too', async () => {
  resetQuotaBreaker();
  const provider = new FallbackProvider(
    new Stub('gemini', 'flash', dailyQuota),
    new Stub('ollama', 'qwen'),
    60_000,
  );
  const schema = z.object({ ok: z.boolean() });
  assert.deepEqual(await provider.generateStructured('p', schema, '{}'), { ok: true });
});

test('a non-quota error is not swallowed by the fallback', async () => {
  resetQuotaBreaker();
  const provider = new FallbackProvider(
    new Stub('gemini', 'flash', () => new LLMError('gemini', 'malformed request', false)),
    new Stub('ollama', 'qwen'),
    60_000,
  );
  await assert.rejects(() => provider.generate('hello'), /malformed request/);
});
