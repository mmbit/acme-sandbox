// Board login with passkeys. A device is enrolled once with a one-time code from the
// "Enroll device" GitHub workflow; after that the tablet unlocks HQ with its screen lock.
import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIPv4, isIPv6 } from 'node:net';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { db } from './db.ts';
import * as challenges from './challenges.ts';
import { ORIGIN, PUBLIC_HOST, REPO_DIR, ZONE } from './config.ts';
import { names } from './company.ts';
import { workflowCommit } from './committed.ts';

const SESSION_DAYS = 90;
const OWN_DEVICE_DAYS = 400;
const secure = ORIGIN.startsWith('https') ? '; Secure' : '';

function cookies(req: IncomingMessage) {
  return Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map(c => c.split('=') as [string, string]));
}

function setCookie(res: ServerResponse, name: string, value: string, maxAge: number) {
  res.appendHeader('set-cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
}

export function isAuthed(req: IncomingMessage) {
  const token = cookies(req).s;
  if (!token) return false;
  const row = db.prepare('select expires from sessions where token = ?').get(token) as { expires: number } | undefined;
  return !!row && row.expires > Date.now();
}

export function startSession(res: ServerResponse) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('insert into sessions (token, expires) values (?, ?)').run(token, Date.now() + SESSION_DAYS * 864e5);
  setCookie(res, 's', token, SESSION_DAYS * 86400);
  markOwnDevice(res);
}

// The board's own devices, marked on every host of the zone so a product's counts skip their visits (Caddy turns the
// mark into X-Own-Device: infra/Caddyfile own_device, shared/metrics counts()). It says nothing but "ours" and opens
// nothing: someone who copies it only leaves themselves out of the counts. Set at each sign-in for as long as a browser
// keeps a cookie (Chrome's most is 400 days), and on a page of HQ's that a signed-in device opens without it.
const OWN_DEVICE = 'hq-own-device';
function markOwnDevice(res: ServerResponse) {
  if (!ZONE) return;   // (on localhost or an IP's host there's no zone, and no product to count)
  // Lax: sent on a page load that comes from another site too (a search, an email's link)
  res.appendHeader('set-cookie', `${OWN_DEVICE}=1; Domain=${ZONE}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${OWN_DEVICE_DAYS * 86400}${secure}`);
}
export function keepOwnDevice(req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'GET' && cookies(req)[OWN_DEVICE] !== '1' && isAuthed(req)) markOwnDevice(res);
}

// Caddy reaches the coordinator only on the voice network (the one network they share, infra/compose.yaml), so the
// address `caddy` resolves to here is the one it connects from. Looked up again after a minute, or after 5 seconds when
// a forwarded request comes from somewhere else (Caddy may have restarted with a new address).
const CADDY = process.env.CADDY_HOST ?? 'caddy';
const caddy = { addrs: new Set<string>(), at: 0 };
const bare = (ip: string) => ip.replace(/^::ffff:(?=[\d.]+$)/i, '');
async function fromCaddy(peer: string) {
  const age = Date.now() - caddy.at;
  if (age > 60_000 || (!caddy.addrs.has(peer) && age > 5_000)) {
    caddy.at = Date.now();
    caddy.addrs = new Set(await lookup(CADDY, { all: true }).then(a => a.map(x => bare(x.address)), () => []));
  }
  return caddy.addrs.has(peer);
}
// An IPv6 client is its /64: the first four groups of the address written out in full (a '::' can stand for any of
// them, so '2001:db8::1' and '2001:db8:0:0::2' are one client), and an IPv4-mapped one is its IPv4 address. The guest
// page (guests.ts) counts its clients the same way.
export const clientOf = async (req: IncomingMessage) => {
  const peer = bare(req.socket?.remoteAddress ?? ''), forwarded = req.headers?.['x-forwarded-for'];
  const ip = forwarded && await fromCaddy(peer) ? String(forwarded).split(',').pop()!.trim() : peer;
  const v4 = /^::ffff:([\d.]+)$/i.exec(ip)?.[1];
  if (v4 && isIPv4(v4)) return v4;
  const v6 = ip.split('%')[0];
  if (!isIPv6(v6)) return ip;
  const groups = (s: string) => s ? s.split(':').flatMap(g => isIPv4(g) ? ['0', '0'] : [g]) : [];   // (a.b.c.d: the last two)
  const [head, tail] = v6.split('::').map(groups);
  const all = tail ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
  return all.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':') + '::/64';
};
// What a held challenge answers for: an enrollment's code (its hash), or the native app's sign-in (app, below)
type Pending = { enrollHash?: string; app?: string };
async function hold(req: IncomingMessage, res: ServerResponse, challenge: string, context: Pending = {}) {
  const client = await clientOf(req);
  const key = randomBytes(16).toString('base64url');
  if (!challenges.hold('board', key, client, challenge, context)) return false;
  setCookie(res, 'c', key, challenges.CHALLENGE_MS / 1000);
  return true;
}

function take(req: IncomingMessage) {
  const key = cookies(req).c;
  if (!key) return;
  const pending = challenges.take<Pending>('board', key);
  return pending && { challenge: pending.challenge, ...pending.context };
}

// Enrollment codes are committed to the repo only as hashes: infra/enroll/<expiry-epoch>.sha256
// one only the Enroll device workflow committed counts, for ENROLL_MS after its
// commit (the link says 30 minutes; the server picks the commit up within a minute), whatever its file name says. A
// merged pull request's file never counts (audit 2026-10-04, I4).
const ENROLL_MS = 35 * 60_000;
const ENROLL_COMMIT = 'Enroll a board device (one-time code, expires in 30 minutes)';   // its subject in enroll.yml
async function validEnrollment(code: string) {
  const hash = createHash('sha256').update(code).digest('hex');
  const dir = `${REPO_DIR}/infra/enroll`;
  if (!existsSync(dir)) return;
  const match = readdirSync(dir).find(f => /^\d+\.sha256$/.test(f) && readFileSync(`${dir}/${f}`, 'utf8').trim() === hash);
  if (!match || db.prepare('select 1 from enrollments where hash = ?').get(hash)) return;
  const committed = await workflowCommit(`infra/enroll/${match}`, ENROLL_COMMIT);
  if (typeof committed === 'number' && Date.now() < committed + ENROLL_MS) return hash;
}

const rp = { expectedOrigin: ORIGIN, expectedRPID: PUBLIC_HOST };

export async function enrollOptions(req: IncomingMessage, res: ServerResponse, body: any) {
  const hash = await validEnrollment(String(body.code ?? ''));
  if (!hash) return 403;
  const options = await generateRegistrationOptions({
    rpName: `${names().name} ${names().hq}`, rpID: PUBLIC_HOST, userName: 'board', userDisplayName: 'The Board',
    // Verification is required, and asked for as required: a device without a fingerprint reader asks for its password
    // then, where 'preferred' let Safari skip it and the verify step refused the passkey.
    attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  return await hold(req, res, options.challenge, { enrollHash: hash }) ? options : 429;
}

export async function enrollVerify(req: IncomingMessage, res: ServerResponse, body: any) {
  const p = take(req);
  if (!p?.enrollHash || db.prepare('select 1 from enrollments where hash = ?').get(p.enrollHash)) return 403;
  const { verified, registrationInfo } = await verifyRegistrationResponse({ response: body, expectedChallenge: p.challenge, ...rp });
  if (!verified || !registrationInfo) return 403;
  const { credential } = registrationInfo;
  db.prepare('insert into enrollments (hash, used) values (?, ?)').run(p.enrollHash, new Date().toISOString());
  db.prepare('insert into credentials (id, public_key, counter, transports, created) values (?, ?, ?, ?, ?)')
    .run(credential.id, credential.publicKey, credential.counter, JSON.stringify(credential.transports ?? []), new Date().toISOString());
  startSession(res);
  return { ok: true };
}

// The native app's sign-in (platform/ios, README "Signing in"). A web view's passkey needs the app tied to HQ's domain
// (Apple's associated domains, a paid developer account), so the app opens /login?app=<challenge> in Apple's sign-in
// sheet, a browser of its own where the passkey works, and the passkey unlocks a one-time code instead of a session: the
// sheet hands it to the app (hq-shell://signed-in?code=…), and the app's web view trades it for a session at
// /app/signed-in with the verifier only the app that opened the sheet holds, sha256(verifier) being the challenge. A
// code taken on the way (another app on the device claiming the scheme) opens nothing without it, and one passkey's
// unlock makes one code, good once for a minute. Nothing here can tell which app opened the page, though: another
// app that opens /login?app=… itself gets the session if the board unlocks there. The page only warns the board, in
// words, to unlock when HQ's app has just opened it. Only an app tied to HQ's domain closes that.
const APP_CODE_MS = 60_000;
const APP_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;   // (a sha256, base64url)
const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');
// The code, held by its sha256 with the app's challenge; undefined when the store is full
function createAppCode(client: string, app: string) {
  const code = randomBytes(32).toString('base64url');
  return challenges.hold('app', sha256(code), client, app, {}, APP_CODE_MS) ? code : undefined;
}
// GET /app/signed-in?code=…&verifier=…: whether the code and verifier started the app's session
export function startAppSession(res: ServerResponse, code: string, verifier: string) {
  const held = challenges.take('app', sha256(code));
  if (!held || sha256(verifier) !== held.challenge) return false;
  startSession(res);
  return true;
}

// {app}: the native app's challenge, when the passkey signs in the app (above)
export async function loginOptions(req: IncomingMessage, res: ServerResponse, body: any = {}) {
  const app = body?.app == null ? undefined : String(body.app);
  if (app !== undefined && !APP_CHALLENGE.test(app)) return 400;
  const options = await generateAuthenticationOptions({ rpID: PUBLIC_HOST, userVerification: 'required' });
  return await hold(req, res, options.challenge, { app }) ? options : 429;
}

export async function loginVerify(req: IncomingMessage, res: ServerResponse, body: any) {
  const p = take(req);
  const row = db.prepare('select * from credentials where id = ?').get(String(body.id)) as any;
  if (!p || p.enrollHash || !row) return 403;
  const { verified, authenticationInfo } = await verifyAuthenticationResponse({
    response: body, expectedChallenge: p.challenge, ...rp,
    credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports) },
  });
  if (!verified) return 403;
  db.prepare('update credentials set counter = ? where id = ?').run(authenticationInfo.newCounter, row.id);
  if (p.app) {
    const code = createAppCode(await clientOf(req), p.app);
    return code ? { app: code } : 429;
  }
  startSession(res);
  return { ok: true };
}
