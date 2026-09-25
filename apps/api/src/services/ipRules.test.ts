import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedAddress } from './ipRules.js';

// Boundary addresses matter more than the obvious ones: an off-by-one in a
// prefix mask is how 172.32.0.0 ends up unreachable or 172.31.255.255 ends up
// reachable, and neither shows up in casual testing.
const BLOCKED: ReadonlyArray<readonly [string, string]> = [
  ['127.0.0.1', 'loopback'],
  ['0.0.0.0', 'unspecified'],
  ['10.1.2.3', 'private class A'],
  ['172.16.0.1', 'private class B, first'],
  ['172.31.255.254', 'private class B, last'],
  ['192.168.1.1', 'private class C'],
  ['169.254.169.254', 'cloud metadata endpoint'],
  ['100.64.0.1', 'carrier grade nat'],
  ['192.0.2.1', 'TEST-NET-1'],
  ['198.18.0.1', 'benchmarking range'],
  ['224.0.0.1', 'multicast'],
  ['255.255.255.255', 'broadcast'],
  ['::1', 'ipv6 loopback'],
  ['fc00::1', 'ipv6 unique local'],
  ['fe80::1', 'ipv6 link local'],
  ['ff02::1', 'ipv6 multicast'],
  ['::ffff:169.254.169.254', 'ipv4-mapped metadata endpoint'],
  ['::ffff:10.0.0.1', 'ipv4-mapped private'],
  ['64:ff9b::a00:1', 'nat64 wrapping a private v4'],
  ['not-an-ip', 'unparseable input'],
];

const ALLOWED: ReadonlyArray<readonly [string, string]> = [
  ['8.8.8.8', 'public resolver'],
  ['1.1.1.1', 'public resolver'],
  ['172.15.0.1', 'one below the private class B block'],
  ['172.32.0.1', 'one above the private class B block'],
  ['100.63.255.255', 'one below carrier grade nat'],
  ['100.128.0.1', 'one above carrier grade nat'],
  ['2606:4700::1111', 'public ipv6'],
];

test('non-routable addresses are rejected', () => {
  for (const [address, label] of BLOCKED) {
    assert.equal(isBlockedAddress(address), true, `${address} (${label}) should be blocked`);
  }
});

test('globally routable addresses are accepted', () => {
  for (const [address, label] of ALLOWED) {
    assert.equal(isBlockedAddress(address), false, `${address} (${label}) should be allowed`);
  }
});
