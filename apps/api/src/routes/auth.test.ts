import test from 'node:test';
import assert from 'node:assert/strict';
import { signupAllowed } from './auth.js';

test('an empty allowlist leaves registration open', () => {
  assert.equal(signupAllowed('anyone@example.com', ''), true);
});

test('the allowlist admits listed emails and whole domains, and nobody else', () => {
  const list = 'aanya.singhal20@gmail.com, @procol.in';
  assert.equal(signupAllowed('aanya.singhal20@gmail.com', list), true);
  assert.equal(signupAllowed('Someone@Procol.in', list), true);
  assert.equal(signupAllowed('stranger@gmail.com', list), false);
  assert.equal(signupAllowed('x@notprocol.in', list), false);
});
