import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { badRequest } from '../errors.js';
import { env } from '../env.js';
import { isBlockedAddress } from './ipRules.js';

export { isBlockedAddress } from './ipRules.js';

/**
 * Validates one URL and returns the addresses it resolves to. Every redirect
 * hop must be revalidated by the caller: the reference implementation checked
 * only the first URL and then followed redirects blindly, so a public host
 * could bounce a request into the metadata service.
 *
 * This cannot close the DNS rebinding window on its own, because the socket
 * resolves the name a second time. Recorded as a known limitation in
 * DECISIONS.md rather than papered over.
 */
export async function assertPublicUrl(rawUrl: string): Promise<string[]> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw badRequest(`not a valid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest(`only http and https URLs can be ingested, got ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw badRequest('URLs with embedded credentials are not accepted');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (env.ALLOW_PRIVATE_URLS) return [hostname];

  const lowered = hostname.toLowerCase();
  if (lowered === 'localhost' || lowered.endsWith('.localhost')) {
    throw badRequest('localhost URLs are not accepted');
  }

  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw badRequest(`address ${hostname} is not globally routable`);
    }
    return [hostname];
  }

  const resolved = await lookup(hostname, { all: true, verbatim: true }).catch(() => {
    throw badRequest(`could not resolve host: ${hostname}`);
  });

  if (resolved.length === 0) {
    throw badRequest(`host resolved to no addresses: ${hostname}`);
  }

  // Every answer must be public. A name resolving to one public and one
  // private address is a rebinding attempt, not a misconfiguration.
  for (const { address } of resolved) {
    if (isBlockedAddress(address)) {
      throw badRequest(`host ${hostname} resolves to non-routable address ${address}`);
    }
  }

  return resolved.map((entry) => entry.address);
}
