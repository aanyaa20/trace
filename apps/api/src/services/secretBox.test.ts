import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seal, unseal, SealError } from './secretBox.js';

test('a sealed secret round-trips', () => {
  const secret = 'abcd efgh ijkl mnop';
  assert.equal(unseal(seal(secret)), secret);
});

test('sealing twice produces different ciphertext', () => {
  assert.notEqual(seal('same'), seal('same'));
});

test('a tampered ciphertext is rejected rather than returned', () => {
  const sealed = seal('app-password');
  const parts = sealed.split('.');
  const flipped = Buffer.from(parts[3]!, 'base64url');
  flipped[0] ^= 0xff;
  parts[3] = flipped.toString('base64url');
  assert.throws(() => unseal(parts.join('.')), SealError);
});

test('a malformed credential is rejected', () => {
  assert.throws(() => unseal('not-sealed'), SealError);
});
