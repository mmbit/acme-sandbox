// A picture on the web fetched for the board's Notebook: one dragged in from another site or pasted as its address,
// which HQ's page can't read itself (the site's CORS). It's a fetch made from inside our network on an address from
// outside, so it's guarded as one: only the open web (SSRF), only pictures, a size and a time it must come within, and
// nothing of the board's sent with it.
import { lookup } from 'node:dns/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import sharp from 'sharp';
import { reply } from '../uploads.ts';

// what a site may send: a camera's full-size photo fits, and more than this held in the coordinator's memory for one
// picture is room the server doesn't have
export const MAX_BYTES = 25 * 1024 * 1024;
// the board waits for it, the picture just let go: a site that takes longer than this has stalled
const WAIT_MS = 10_000;
// a site's redirects followed (a CDN's are one or two): more is a loop
const HOPS = 5;
// rasters only, which HQ draws again (bookscrapdraw.js shrink): an SVG is a page that could run scripts on HQ's origin.
// A site may call a picture anything binary; the bytes say what it is.
const SAID = /^(image\/|application\/octet-stream$|binary\/octet-stream$)/;
const FORMATS = new Set(['jpeg', 'png', 'gif', 'webp', 'avif']);

// Addresses inside a network, never fetched: this machine, private and shared networks, link-local (a cloud's metadata
// service), benchmarking, documentation, multicast and reserved ranges, and IPv6's ways into them (IPv4-mapped
// addresses are checked as the IPv4 address they carry)
const INSIDE = new BlockList();
// prettier-ignore
const INSIDE_V4 = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const;
// prettier-ignore
const INSIDE_V6 = [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const;
for (const [net, prefix] of INSIDE_V4) INSIDE.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of INSIDE_V6) INSIDE.addSubnet(net, prefix, 'ipv6');
const onTheWeb = (address: string) => !INSIDE.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');

type Fetched = { type: string; bytes: Buffer };
// (page: the address is a page, not a picture, which HQ lands as a link's words; any other refusal is a picture that
// didn't come)
type Refusal = [number, string, { page: true }?];
type Address = { address: string; family: number };

// GET /api/book/fetch?url=<http(s) address>: the picture there, as its bytes, or { error } with why it didn't come
// ({ error, page: true } when the address is a page, not a picture).
// reachable: the addresses it may connect to (a test lets a local server stand in for the web).
export async function fetchPicture(res: ServerResponse, address: string, reachable = onTheWeb) {
  const got = await pictureAt(address, reachable).catch(refusalOf);
  if (Array.isArray(got)) return reply(res, got[0], { error: got[1], ...got[2] });
  // (served from HQ's origin: never sniffed into anything else, and sandboxed if opened on its own)
  res.writeHead(200, {
    'content-type': got.type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  });
  res.end(got.bytes);
}

// The picture at an address, through the site's redirects, each address checked again
async function pictureAt(address: string, reachable: (address: string) => boolean): Promise<Fetched | Refusal> {
  const signal = AbortSignal.timeout(WAIT_MS);
  let url = parsed(address);
  for (let hop = 0; hop <= HOPS; hop++) {
    if (Array.isArray(url)) return url;
    const answer = await get(url, reachable, signal);
    if (Array.isArray(answer)) return answer;
    const status = answer.statusCode ?? 0,
      to = answer.headers.location;
    if (status >= 300 && status < 400 && to) {
      answer.resume();
      url = parsed(new URL(to, url).href);
      continue;
    }
    if (status !== 200) {
      answer.resume();
      return [502, `the site answered ${status} for that picture`];
    }
    return readPicture(answer);
  }
  return [502, 'the site kept sending the picture somewhere else'];
}
function parsed(address: string): URL | Refusal {
  const url = URL.parse(address);
  if (!url || !['http:', 'https:'].includes(url.protocol)) return [400, 'a picture’s http or https address only'];
  if (url.username || url.password) return [400, 'an address with a login in it isn’t fetched'];
  return url;
}

// The site's answer for a URL. Its name is looked up here and the connection made to the address checked, never
// looked up again (a site's DNS could answer an inside address the second time). Nothing of the board's goes with it:
// no cookies, no referrer, no login.
async function get(url: URL, reachable: (address: string) => boolean, signal: AbortSignal) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookedUp(host, signal);
  if (!addresses.length) return [502, `${host} couldn’t be found`] as Refusal;
  if (!addresses.every(a => reachable(a.address)))
    return [403, `${host} is on a private network: only pictures on the open web are fetched`] as Refusal;
  const pinned: LookupFunction = (_name, options, done) =>
    options.all ? done(null, addresses) : done(null, addresses[0].address, addresses[0].family);
  const headers = { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1' };
  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(
      url,
      { headers, lookup: pinned, signal, agent: false },
      resolve,
    );
    request.on('error', reject);
    request.end();
  });
}

// A name's addresses ([] when it has none), within the fetch's time: the resolver takes no signal, so a stalled lookup
// ends with the time rather than its own timeout
async function lookedUp(host: string, signal: AbortSignal): Promise<Address[]> {
  signal.throwIfAborted();
  const stalled = new Promise<null>(done => signal.addEventListener('abort', () => done(null), { once: true }));
  const addresses = await Promise.race([lookup(host, { all: true }).catch(() => []), stalled]);
  if (!addresses) throw signal.reason;
  return addresses;
}

// The answer's body read up to MAX_BYTES, kept if its bytes are a picture HQ draws: { type, bytes }
async function readPicture(answer: IncomingMessage): Promise<Fetched | Refusal> {
  const said = String(answer.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const tooBig: Refusal = [413, `that picture is over ${MAX_BYTES / 1024 / 1024} MB`];
  if (!SAID.test(said)) {
    answer.destroy();
    return [415, 'that address is a page, not a picture', { page: true }];
  }
  if (Number(answer.headers['content-length']) > MAX_BYTES) {
    answer.destroy();
    return tooBig;
  }
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of answer as AsyncIterable<Buffer>) {
    size += part.length;
    if (size > MAX_BYTES) {
      answer.destroy();
      return tooBig;
    }
    parts.push(part);
  }
  const bytes = Buffer.concat(parts);
  const about = await sharp(bytes)
    .metadata()
    .catch(() => null);
  // (sharp reads an AVIF as a HEIF compressed with AV1: a phone's HEIC is HEIF too, which browsers can't draw)
  const format = about?.format === 'heif' && about.compression === 'av1' ? 'avif' : about?.format;
  if (!format || !FORMATS.has(format)) return [415, 'not a picture HQ can show: a JPEG, PNG, GIF, WebP or AVIF only'];
  return { type: `image/${format}`, bytes };
}

// A fetch that failed on the way: the site too slow, or out of reach
function refusalOf(e: Error & { code?: string }): Refusal {
  if (e.name === 'TimeoutError' || e.name === 'AbortError')
    return [504, `the site didn’t send the picture within ${WAIT_MS / 1000} seconds`];
  return [502, `the site couldn’t be reached (${e.code ?? e.message})`];
}
