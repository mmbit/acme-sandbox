// Who a request comes from, for limits by address: the client as Caddy saw it, an IPv6 address by its /64.
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

// The request's client: Caddy appends the address it sees to X-Forwarded-For, so only the last entry can be trusted.
// Without one (a local run), the socket's. addressOf gives it whole, clientOf as a limit counts it.
// (addressOf, for an address sent on whole)
export function addressOf(req: IncomingMessage) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .pop()!
    .trim();
  return forwarded || req.socket.remoteAddress || '';
}
export const clientOf = (req: IncomingMessage) => net(addressOf(req));

// What a limit by address counts: an IPv4 address whole, an IPv6 one by its /64, since one IPv6 host usually has the
// whole /64 to pick from. Anything else stays as it came.
export function net(ip: string) {
  const address = ip.trim().toLowerCase().replace(/%.*$/, '');
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address); // an IPv4 address, or one mapped into IPv6
  if (v4 && isIP(v4[1]) === 4) return v4[1];
  if (isIP(address) !== 6) return ip;
  const n = groupsOf(address).map(g => parseInt(g, 16));
  // an IPv4 address mapped in hex (::ffff:cb00:7107) is that IPv4 address too, not one shared /64
  if (n.slice(0, 5).every(g => g === 0) && n[5] === 0xffff)
    return [n[6] >> 8, n[6] & 255, n[7] >> 8, n[7] & 255].join('.');
  return `${n
    .slice(0, 4)
    .map(g => g.toString(16))
    .join(':')}::/64`;
}

// An IPv6 address's eight groups, with :: filled in (a dotted IPv4 tail is its two groups: 1.2.3.4 is 102:304)
function groupsOf(address: string) {
  const hex = (a: number, b: number) => ((a << 8) | b).toString(16);
  const part = (x: string | undefined) =>
    x
      ? x.split(':').flatMap(g => {
          if (!g.includes('.')) return [g];
          const [a, b, c, d] = g.split('.').map(Number);
          return [hex(a, b), hex(c, d)];
        })
      : [];
  const [head, tail] = address.split('::');
  const left = part(head);
  const right = part(tail);
  if (tail === undefined) return left;
  return [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
}
