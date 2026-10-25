// The watch-along's mirror and a preview's files: the pictures, fonts and stylesheets a recorded page showed on a preview
// host, fetched for the replay (watchalong.ts) on a pass of HQ's own, which preview.ts check lets through. Apart from
// preview.ts, which reaches the shares and payments: the watch-along loads with the calls, before those are ready.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { extname } from 'node:path';
import { PREVIEW, ZONE } from './config.ts';

// (preview.ts hashes its passes with it too)
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// The watch-along's mirror (watchalong.ts) replays a page that was on a preview host, and the replay asks for the
// pictures, fonts and stylesheets it showed. HQ fetches them through Caddy, as a visitor with nothing held, on a pass of
// its own: the pp cookie of its own requests alone (Caddy keeps it from the product, as a job's pass), kept in memory,
// one for each host, for MIRROR_PASS_MS. It opens GETs of MIRRORED files on its host and nothing else: never a page, a
// script, the chat's route or review mode. The replay gets each file as the type its name says, whatever the product
// answers. PREVIEWS_VIA: where the requests go, the host's own address unless set (a test's stand-in, told the host in
// Host).
export const MIRRORED: Record<string, string> = {
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};
const MIRROR_PASS_MS = 10 * 60_000;
// The largest file it takes: the coordinator holds each in memory while the replay loads it, a picture at a phone
// camera's full size fits, and a bigger one shows as an empty box with a line in the log
const MIRRORED_BYTES = 16 * 1024 * 1024;
const PREVIEWS_VIA = process.env.PREVIEWS_VIA ?? '';
const mirrorPasses = new Map<string, { secret: string; expires: number }>();

// A preview's file for the mirror, within ms: its bytes and type, or null (not a file the pass opens, or not there).
// Too big or too slow fails.
export function mirrored(url: URL, ms: number): Promise<{ type: string; body: Buffer } | null> {
  const type = MIRRORED[extname(url.pathname).toLowerCase()];
  if (!ZONE || url.protocol !== 'https:' || url.port || !url.hostname.endsWith(PREVIEW) || !type) {
    return Promise.resolve(null);
  }
  // (field by field: a recorded path of //host/x.png, parsed as an address, would name another host)
  const via = new URL(PREVIEWS_VIA || url.origin);
  via.pathname = url.pathname;
  via.search = url.search;
  const send = via.protocol === 'http:' ? httpRequest : httpsRequest;
  const headers = { host: url.host, cookie: `pp=${mirrorPass(url.host)}` };
  return new Promise((resolve, reject) => {
    const asked = send(via, { headers, signal: AbortSignal.timeout(ms) }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MIRRORED_BYTES) return void chunks.push(chunk);
        asked.destroy(new Error(`larger than ${MIRRORED_BYTES / 1024 / 1024} MB`));
      });
      res.on('end', () => resolve({ type, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    asked.on('error', reject);
    asked.end();
  });
}
// The host's pass, a new one when the last has less than a minute left
function mirrorPass(host: string) {
  const now = Date.now();
  for (const [at, pass] of mirrorPasses) if (pass.expires <= now) mirrorPasses.delete(at);
  const held = mirrorPasses.get(host);
  if (held && held.expires > now + 60_000) return held.secret;
  const secret = randomBytes(32).toString('base64url');
  mirrorPasses.set(host, { secret, expires: now + MIRROR_PASS_MS });
  return secret;
}
// Whether Caddy's check (preview.ts check) is for a request the mirror's pass opens: a GET of a MIRRORED file on the
// pass's host. pp: the request's pp cookie; method: the one Caddy forwarded.
export function mirrorOpens(pp: string | undefined, method: unknown, host: string, uri: string) {
  const pass = mirrorPasses.get(host),
    given = Buffer.from(sha256(pp ?? ''));
  if (!pass || pass.expires <= Date.now() || !timingSafeEqual(given, Buffer.from(sha256(pass.secret)))) return false;
  const path = new URL(uri, 'https://x').pathname;
  return method === 'GET' && Object.hasOwn(MIRRORED, extname(path).toLowerCase());
}
