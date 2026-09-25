import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanSse } from './sse.js';

const frame = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

test('complete frames yield their deltas in order', () => {
  const scan = scanSse(`${frame('Hello')}${frame(' world')}`);
  assert.deepEqual(scan.deltas, ['Hello', ' world']);
  assert.equal(scan.rest, '');
  assert.equal(scan.done, false);
});

test('a frame split across reads is carried over, not dropped', () => {
  const whole = frame('Retrieval');
  const cut = whole.slice(0, 20);

  const first = scanSse(cut);
  assert.deepEqual(first.deltas, [], 'half a frame emits nothing');

  // The tail is prepended to the next read, which is what the caller does.
  const second = scanSse(first.rest + whole.slice(20));
  assert.deepEqual(second.deltas, ['Retrieval']);
});

test('[DONE] ends the stream and discards the tail', () => {
  const scan = scanSse(`${frame('a')}data: [DONE]\n\ndata: {"ignored":true}\n\n`);
  assert.deepEqual(scan.deltas, ['a']);
  assert.equal(scan.done, true);
  assert.equal(scan.rest, '');
});

test('a malformed frame is skipped rather than failing the stream', () => {
  const scan = scanSse(`${frame('good')}data: {not json}\n\n${frame(' still good')}`);
  assert.deepEqual(scan.deltas, ['good', ' still good']);
});

test('keepalive comments and empty deltas produce nothing', () => {
  const scan = scanSse(`: keepalive\n\ndata: {"choices":[{"delta":{}}]}\n\n${frame('x')}`);
  assert.deepEqual(scan.deltas, ['x']);
});

test('a role-only opening frame contributes no text', () => {
  const scan = scanSse('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
  assert.deepEqual(scan.deltas, []);
});
