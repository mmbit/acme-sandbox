// node --test shared/net/net.test.ts   (no server: requests are stand-ins with headers and a socket)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { clientOf, net } from './net.ts';

test('limits by address count an IPv4 address whole and an IPv6 one by its /64', () => {
  assert.equal(net('203.0.113.7'), '203.0.113.7');
  assert.equal(net('::ffff:203.0.113.7'), '203.0.113.7', 'an IPv4 address mapped into IPv6 is that IPv4 address');
  assert.equal(net('::ffff:cb00:7107'), '203.0.113.7', 'in hex too');
  assert.equal(net('0:0:0:0:0:ffff:cb00:7107'), '203.0.113.7');
  assert.equal(net('0:0:0:0:0:ffff:203.0.113.7'), '203.0.113.7', 'written out, with a dotted tail');
  assert.equal(net('2001:db8:aa:bb::1.2.3.4'), '2001:db8:aa:bb::/64');
  const sameNetwork = ['2001:db8:aa:bb:1:2:3:4', '2001:DB8:AA:BB::9', '2001:0db8:00aa:00bb:ffff::1'];
  for (const ip of sameNetwork) assert.equal(net(ip), '2001:db8:aa:bb::/64', ip);
  assert.equal(net('2001:db8::1:2:3:4:5'), '2001:db8:0:1::/64', 'the :: filled with as many groups as it stands for');
  assert.equal(net('2001:db8::'), '2001:db8:0:0::/64');
  assert.equal(net('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.notEqual(net('2001:db8:aa:bb::1'), net('2001:db8:aa:bc::1'));
  assert.equal(net(''), '');
  assert.equal(net('not an address'), 'not an address');
});

const request = (forwarded: string | undefined, socket = '10.0.0.9') =>
  ({
    headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
    socket: { remoteAddress: socket },
  }) as unknown as IncomingMessage;

test("a request's client is the last X-Forwarded-For entry (Caddy's), grouped by its network", () => {
  assert.equal(clientOf(request('198.51.100.1, 203.0.113.7')), '203.0.113.7', 'an entry the client wrote is ignored');
  assert.equal(clientOf(request('2001:db8:1234:5678::1')), clientOf(request('2001:db8:1234:5678::2')));
  assert.equal(clientOf(request(undefined, '::ffff:127.0.0.1')), '127.0.0.1', "without the header, the socket's");
  assert.equal(clientOf(request('')), '10.0.0.9');
});
