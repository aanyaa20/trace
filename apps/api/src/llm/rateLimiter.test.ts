import test from 'node:test';
import assert from 'node:assert/strict';
import { isDailyQuotaExhausted, serverRequestedDelayMs } from './rateLimiter.js';

test('reads the retryDelay field out of a quota error body', () => {
  const error = new Error(
    '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"40s"}]}}',
  );
  assert.equal(serverRequestedDelayMs(error), 40_000);
});

test('falls back to the prose form of the same instruction', () => {
  assert.equal(serverRequestedDelayMs(new Error('Please retry in 31.69s.')), 31_690);
});

test('returns null when the service suggested nothing', () => {
  assert.equal(serverRequestedDelayMs(new Error('503 service unavailable')), null);
  assert.equal(serverRequestedDelayMs(undefined), null);
});

test('a per-day quota violation is recognised as terminal', () => {
  const daily = new Error(
    '{"error":{"code":429,"details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaValue":"20"}]}]}}',
  );
  assert.equal(isDailyQuotaExhausted(daily), true);
});

test('a per-minute quota violation is not terminal', () => {
  const perMinute = new Error(
    '{"error":{"code":429,"details":[{"violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier","quotaValue":"5"}]}]}}',
  );
  assert.equal(isDailyQuotaExhausted(perMinute), false);
});

test("reads Groq's wording of the same instruction, seconds and minutes", () => {
  const groq = new Error(
    'chat/completions returned 429: {"error":{"message":"Rate limit reached for model `openai/gpt-oss-20b` ... on tokens per minute (TPM): Limit 8000, Used 6145, Requested 4269. Please try again in 18.105s. Need more tokens?"}}',
  );
  assert.equal(serverRequestedDelayMs(groq), 18_105);
  assert.equal(serverRequestedDelayMs(new Error('Please try again in 1m2.5s.')), 62_500);
  assert.equal(serverRequestedDelayMs(new Error('Please try again in 2m.')), 120_000);
});

test('a caller with a fallback gives up rather than wait out a long pause', async () => {
  const { withRetry } = await import('./rateLimiter.js');
  let calls = 0;
  const started = Date.now();
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new Error('429 Rate limit reached ... Please try again in 45.2s.');
      },
      4,
      () => true,
      undefined,
      20_000,
    ),
  );
  assert.equal(calls, 1, 'no retry when the server asks for longer than the cap');
  assert.ok(Date.now() - started < 1000, 'and no waiting');
});
