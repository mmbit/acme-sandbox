// Web Push to the board's devices, with node:crypto only: a VAPID key pair (RFC 8292) made on first start
// and kept in the database, an ES256 JWT per push service, and aes128gcm payload encryption (RFC 8291/8188).
// Only what needs the board right now is pushed; everything else waits for the daily digest.
import { createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, createCipheriv, randomBytes, sign } from 'node:crypto';
import { db } from './db.ts';
import { ORIGIN, PUBLIC_HOST } from './config.ts';
import { names, cap } from './company.ts';
import { SHOWN } from './shown.ts';
import * as tips from './tips.ts';

// The CEO's emergency pings (hq ping) went on 18 October 2026 (the board: a card marked now rings, so that's one way to
// ring, not two). Their log goes.
db.exec('drop table if exists pings');

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');
// Apple wants a contact it can reach: the HQ address (or PUSH_CONTACT, a mailto: or https: URL).
const CONTACT = process.env.PUSH_CONTACT ?? (ORIGIN.startsWith('https') ? ORIGIN : 'mailto:board@example.com');
const LOCAL = PUBLIC_HOST === 'localhost';

type Sub = { endpoint: string; p256dh: string; auth: string };
export type Message = { title: string; body: string; tag?: string; url?: string; count?: number };

// ---- the VAPID key pair: made once, then the same key forever (a new one would orphan every subscription)
function vapidJwk() {
  const get = () => db.prepare("select value from settings where key = 'vapid'").get() as { value: string } | undefined;
  if (!get()) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    db.prepare("insert or ignore into settings (key, value) values ('vapid', ?)").run(JSON.stringify(privateKey.export({ format: 'jwk' })));
  }
  return JSON.parse(get()!.value);
}
const jwk = vapidJwk();
const vapidKey = createPrivateKey({ key: jwk, format: 'jwk' });
export const publicKey = b64(Buffer.concat([Buffer.from([4]), unb64(jwk.x), unb64(jwk.y)])); // the applicationServerKey

// Signed per push, valid for an hour: Mozilla, Google and Apple all accept that. The audience is the push
// service's own origin, read from the device's endpoint (fcm.googleapis.com, updates.push.services.mozilla.com,
// web.push.apple.com, ...).
function vapidHeader(endpoint: string, now = Date.now()) {
  const part = (o: object) => b64(Buffer.from(JSON.stringify(o)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 3600, sub: CONTACT })}`;
  const sig = sign('sha256', Buffer.from(unsigned), { key: vapidKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64(sig)}, k=${publicKey}`;
}

// ---- aes128gcm (RFC 8291 section 3.4): one record, keyed by a throwaway ECDH key and the device's secrets.
function encrypt(plaintext: Buffer, p256dh: string, auth: string) {
  const ua = unb64(p256dh), ecdh = createECDH('prime256v1'), salt = randomBytes(16);
  ecdh.generateKeys();
  const as = ecdh.getPublicKey(), secret = ecdh.computeSecret(ua);
  const hkdf = (ikm: Uint8Array, s: Uint8Array, info: string | Buffer, n: number) => Buffer.from(hkdfSync('sha256', ikm, s, info, n));
  const ikm = hkdf(secret, unb64(auth), Buffer.concat([Buffer.from('WebPush: info\0'), ua, as]), 32);
  const cek = hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16), nonce = hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12);
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([plaintext, Buffer.from([2])])), c.final(), c.getAuthTag()]); // 0x02: last record
  const head = Buffer.alloc(21); salt.copy(head); head.writeUInt32BE(4096, 16); head[20] = as.length;
  return Buffer.concat([head, as, body]);
}

// ---- subscriptions, one per device
export function subscribe(b: any, device?: string) {
  const endpoint = String(b?.endpoint ?? ''), p256dh = String(b?.keys?.p256dh ?? ''), auth = String(b?.keys?.auth ?? '');
  let url: URL;
  try { url = new URL(endpoint); } catch { return 400; }
  if (endpoint.length > 1024 || !(url.protocol === 'https:' || (LOCAL && url.protocol === 'http:'))) return 400;
  const key = unb64(p256dh);
  if (key.length !== 65 || key[0] !== 4 || unb64(auth).length !== 16) return 400;
  db.prepare(`insert into push_subscriptions (endpoint, p256dh, auth, device, created) values (?, ?, ?, ?, ?)
    on conflict(endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device`)
    .run(endpoint, p256dh, auth, (device ?? '').slice(0, 200), new Date().toISOString());
  return { ok: true, devices: devices() };
}
export function unsubscribe(b: any) {
  db.prepare('delete from push_subscriptions where endpoint = ?').run(String(b?.endpoint ?? ''));
  return { ok: true, devices: devices() };
}
export const devices = () => (db.prepare('select count(*) n from push_subscriptions').get() as { n: number }).n;

// ---- sending
async function pushTo(s: Sub, m: Message, ttl: number) {
  const res = await fetch(s.endpoint, {
    method: 'POST', signal: AbortSignal.timeout(10_000),
    // Topic: a newer push replaces one the push service still holds for an offline device
    headers: { authorization: vapidHeader(s.endpoint), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
      ttl: String(ttl), urgency: 'high', topic: m.tag ?? 'hq' },
    body: encrypt(Buffer.from(JSON.stringify(m)), s.p256dh, s.auth),
  });
  if (res.status === 404 || res.status === 410) { // the device unsubscribed or the subscription expired
    db.prepare('delete from push_subscriptions where endpoint = ?').run(s.endpoint);
    return 'pruned';
  }
  if (!res.ok) throw new Error(`${new URL(s.endpoint).host} ${res.status} ${(await res.text()).slice(0, 200)}`);
  return 'sent';
}

// Every device (or just one), best effort. Never throws: a failed push must not break what triggered it.
export async function sendToBoard(m: Message, { endpoint, ttl = 6 * 3600 }: { endpoint?: string; ttl?: number } = {}) {
  const subs = (endpoint
    ? db.prepare('select * from push_subscriptions where endpoint = ?').all(endpoint)
    : db.prepare('select * from push_subscriptions').all()) as Sub[];
  const out = { sent: 0, pruned: 0, failed: 0 };
  await Promise.all(subs.map(s => pushTo(s, m, ttl).then(r => { out[r]++; },
    err => { out.failed++; console.error('Could not send a push:', err.message); })));
  return out;
}

export const sendTest = (b: any) => sendToBoard({ title: `${cap(names().phone)} ☎`, body: 'Test call: notifications work on this device.',
  tag: 'hq-test', url: '/?open=phone' }, { endpoint: b?.endpoint || undefined, ttl: 300 });

// The cards on the desk phone now, waiting for an answer: not those for later (later.ts), nor tips (tips.ts)
export const waitingCards = () =>
  (db.prepare(`select count(*) n from requests where status = 'open' and kind != '${tips.KIND}' and ${SHOWN}`).get(new Date().toISOString()) as { n: number }).n;

// A new board request. Urgent ones ("now") and seat sign-ins ring the board's devices; one tag, so a newer
// call replaces the older notification instead of stacking.
// The daily digest hooks in here too: requests that don't ring now simply stay open, and the digest (still to
// build) will be a scheduled job that reads the open requests created since its last run and sends one
// summary with sendToBoard({ title: 'Desk phone: today', body: '3 requests are waiting', tag: 'desk-digest' }).
export function announceRequest(r: { id: number; kind: string; title: string; urgency?: string; grant?: string }) {
  if (r.urgency !== 'now' && r.kind !== 'login') return;
  sendToBoard({ title: `${cap(names().phone)} ☎`, body: [r.title.slice(0, 200), r.grant].filter(Boolean).join(' '), tag: 'desk-phone', url: '/?open=phone', count: waitingCards() })
    .catch(err => console.error('Could not announce the request:', err));
}
