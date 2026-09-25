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
