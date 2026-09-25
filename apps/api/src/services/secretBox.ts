import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { env } from '../env.js';

/**
 * Connector credentials are app passwords: anything holding one can read the
 * whole mailbox, so they are encrypted at rest rather than stored beside the
 * row that uses them. A dump of the connectors table is then not a set of
 * working credentials.
 *
 * The key is derived from JWT_SECRET rather than introducing a second secret to
 * manage. That couples them deliberately: rotating JWT_SECRET invalidates every
 * stored credential, which is the correct blast radius — if the signing key
 * leaked, the credentials sealed with a key derived from it are suspect too.
 */
const KEY = scryptSync(env.JWT_SECRET, 'trace.connector.secret.v1', 32);
const VERSION = 'v1';

export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

export class SealError extends Error {}

export function unseal(sealed: string): string {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || !body) {
    throw new SealError('stored credential is not in the expected format');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Either the ciphertext was tampered with or JWT_SECRET changed. Both mean
    // the same thing to a caller: this credential cannot be used again.
    throw new SealError('stored credential could not be decrypted; reconnect the mailbox');
  }
}
