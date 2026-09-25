import { isIP } from 'node:net';

/**
 * Address classification, deliberately free of any dependency on application
 * configuration so it can be tested on its own. The policy that consumes it
 * lives in ssrf.ts.
 *
 * The list is the complement of "globally routable" rather than a list of
 * obviously private ranges: checking only private, loopback, link-local and
 * reserved, as the reference implementation does, leaves carrier grade NAT
 * (100.64/10) and the broadcast address reachable.
 */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4ToInt(address: string): number | null {
  const octets = address.split('.');
  if (octets.length !== 4) return null;

  let value = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return null;
    const parsed = Number(octet);
    if (parsed > 255) return null;
    value = (value << 8) | parsed;
  }
  return value >>> 0;
}

function isBlockedV4(address: string): boolean {
  const value = v4ToInt(address);
  if (value === null) return true;

  return BLOCKED_V4.some(([network, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const networkValue = v4ToInt(network);
    return networkValue !== null && (value & mask) === (networkValue & mask);
  });
}

function isBlockedV6(address: string): boolean {
  const normalised = (address.toLowerCase().split('%')[0] ?? '').trim();

  // An IPv4-mapped address such as ::ffff:10.0.0.1 is an IPv4 destination in
  // a v6 costume, so it has to be judged by the v4 rules.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalised);
  if (mapped?.[1]) return isBlockedV4(mapped[1]);

  if (normalised === '::1' || normalised === '::') return true;

  const first = parseInt(normalised.split(':')[0] || '0', 16);
  if (Number.isNaN(first)) return true;

  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (normalised.startsWith('2001:db8:')) return true; // documentation range
  if (normalised.startsWith('64:ff9b:')) return true; // nat64 onto arbitrary v4
  return false;
}

/** Unparseable input is treated as blocked: failing closed is the only safe
 *  default for a guard. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedV4(address);
  if (family === 6) return isBlockedV6(address);
  return true;
}
