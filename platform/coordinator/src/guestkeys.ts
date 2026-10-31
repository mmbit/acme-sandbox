// Guest passkeys open only the email-verified guest desk session.
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { db } from './db.ts';
import { ORIGIN, PUBLIC_HOST } from './config.ts';
import { names } from './company.ts';
import { clientOf } from './auth.ts';
import * as challenges from './challenges.ts';
import { JSON_MAX, parseJson, readBody } from '../../../shared/routes/routes.ts';

db.exec(`create table if not exists guest_credentials (
  id text primary key, guest text not null collate nocase, public_key blob not null,
  counter integer not null, transports text not null, created text not null);`);

type Identity = { name: string; email: string | null };
export const enrollmentScope = 'passkeys/enroll';
export const loginScope = (token: string) => `${token}/passkey`;
type Context = Identity & { scope: string; session: string };
type Credential = { id: string; guest: string; public_key: Uint8Array; counter: number; transports: string };
type Held = Context & { purpose: string };
const secure = ORIGIN.startsWith('https:') ? '; Secure' : '';
const rp = { expectedOrigin: ORIGIN, expectedRPID: PUBLIC_HOST, requireUserVerification: true };
const keys = (guest: string) =>
  db.prepare('select * from guest_credentials where guest = ?').all(guest) as Credential[];
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const cookie = (req: IncomingMessage) => /(?:^|;\s*)guest-passkey=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
const live = (identity: Identity) =>
  !!db
    .prepare('select 1 from guests where name = ? and email = ? and revoked is null')
    .get(identity.name, identity.email);

const SCRIPT = readFileSync(new URL('./guestkeys.js', import.meta.url));
type FindIdentity = (enroll: boolean, token: string) => Context | null;
type StartSession = (name: string) => { 'set-cookie': string };
export async function page(req: IncomingMessage, res: ServerResponse, find: FindIdentity, start: StartSession) {
  const path = new URL(req.url ?? '/', ORIGIN).pathname;
  if (req.method === 'GET' && path === '/guest/guestkeys.js') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' });
    res.end(SCRIPT);
    return true;
  }
  const match = /^\/guest\/(passkeys\/enroll|[A-Za-z0-9_-]{43}\/passkey)\/(options|verify)$/.exec(path);
  if (!match) return false;
  if (req.method !== 'POST' || req.headers.origin !== ORIGIN) return respond(res, 403, { error: 'origin' });
  const enroll = match[1] === enrollmentScope,
    token = match[1].split('/')[0];
  const before = find(enroll, token);
  if (!before) return respond(res, 403, { error: 'guest' });
  const bytes = await readBody(req, JSON_MAX);
  if (!bytes) return respond(res, 413, { error: 'body' });
  const body = parseJson(bytes);
  if (body === null) return respond(res, 400, { error: 'body' });
  const person = find(enroll, token);
  if (!person || person.name !== before.name || person.email !== before.email)
    return respond(res, 403, { error: 'guest' });
  const answer =
    match[2] === 'options' ? await options(req, res, person, enroll) : await verify(req, person, enroll, body);
  if (typeof answer === 'number') return respond(res, answer, { error: 'passkey' });
  if (!enroll && match[2] === 'verify') {
    if (!find(enroll, token)) return respond(res, 403, { error: 'guest' });
    res.appendHeader('set-cookie', start(person.name)['set-cookie']);
  }
  return respond(res, 200, answer);
}
function respond(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

export const has = (guest: string) => keys(guest).length > 0;
export function forget(guest: string) {
  db.prepare('delete from guest_credentials where guest = ?').run(guest);
  challenges.forgetGuest(guest);
}

export async function options(req: IncomingMessage, res: ServerResponse, identity: Context, enroll: boolean) {
  if (!live(identity)) return 403;
  if (enroll && !signedIn(identity)) return 403;
  const credentials = keys(identity.name).map(row => ({ id: row.id, transports: JSON.parse(row.transports) }));
  if (!enroll && !credentials.length) return 403;
  const options = enroll
    ? await generateRegistrationOptions({
        rpName: `${names().name} Notebook`,
        rpID: PUBLIC_HOST,
        userID: new Uint8Array(createHash('sha256').update(`guest:${identity.name.toLowerCase()}`).digest()),
        userName: identity.email!,
        userDisplayName: identity.name,
        excludeCredentials: credentials,
        attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      })
    : await generateAuthenticationOptions({
        rpID: PUBLIC_HOST,
        userVerification: 'required',
        allowCredentials: credentials,
      });
  return (await hold(req, res, identity, enroll ? 'enroll' : 'login', options.challenge)) ? options : 429;
}

async function hold(req: IncomingMessage, res: ServerResponse, identity: Context, purpose: string, challenge: string) {
  const client = await clientOf(req);
  if (!live(identity)) return false;
  const token = randomBytes(32).toString('base64url');
  if (
    !challenges.hold('guest', sha256(token), client, challenge, {
      name: identity.name,
      email: identity.email,
      scope: identity.scope,
      session: identity.session,
      purpose,
    } satisfies Held)
  )
    return false;
  res.appendHeader(
    'set-cookie',
    `guest-passkey=${token}; Path=/guest/; HttpOnly; SameSite=Strict; Max-Age=${challenges.CHALLENGE_MS / 1000}${secure}`,
  );
  return true;
}

export async function verify(req: IncomingMessage, identity: Context, enroll: boolean, response: any) {
  const pending = await take(req, identity, enroll ? 'enroll' : 'login');
  if (!pending || !response || typeof response.id !== 'string') return 403;
  return enroll
    ? await register(identity, pending.challenge, response)
    : await login(identity, pending.challenge, response);
}

async function take(req: IncomingMessage, identity: Context, purpose: string) {
  const client = await clientOf(req),
    token = cookie(req);
  if (!token) return;
  const pending = challenges.take<Held>('guest', sha256(token));
  if (!pending) return;
  const held = pending.context;
  if (
    held.purpose !== purpose ||
    pending.client !== client ||
    held.name.toLowerCase() !== identity.name.toLowerCase() ||
    held.email !== identity.email ||
    held.scope !== identity.scope ||
    held.session !== identity.session ||
    !live(identity)
  )
    return;
  if (purpose === 'enroll' && !signedIn(identity)) return;
  return pending;
}

const signedIn = (identity: Context) =>
  !!db
    .prepare('select 1 from guest_sessions where hash = ? and guest = ? and expires > ?')
    .get(identity.session, identity.name, Date.now());

async function register(identity: Context, challenge: string, response: any) {
  let registration;
  try {
    registration = await verifyRegistrationResponse({ response, expectedChallenge: challenge, ...rp });
  } catch {
    // Authenticator replies are untrusted and contain credential material that never goes to logs.
    return 403;
  }
  if (!registration.verified || !registration.registrationInfo || !live(identity)) return 403;
  if (!signedIn(identity)) return 403;
  const credential = registration.registrationInfo.credential;
  if (db.prepare('select 1 from guest_credentials where id = ?').get(credential.id)) return 409;
  db.prepare(
    'insert into guest_credentials (id, guest, public_key, counter, transports, created) values (?, ?, ?, ?, ?, ?)',
  ).run(
    credential.id,
    identity.name,
    credential.publicKey,
    credential.counter,
    JSON.stringify(credential.transports ?? []),
    new Date().toISOString(),
  );
  return { ok: true };
}

async function login(identity: Context, challenge: string, response: any) {
  const credential = keys(identity.name).find(row => row.id === response.id);
  if (!credential) return 403;
  let authentication;
  try {
    authentication = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      ...rp,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(credential.public_key),
        counter: credential.counter,
        transports: JSON.parse(credential.transports),
      },
    });
  } catch {
    // Authenticator replies are untrusted and contain credential material that never goes to logs.
    return 403;
  }
  if (!authentication.verified || !live(identity)) return 403;
  const updated = db
    .prepare('update guest_credentials set counter = ? where id = ? and counter = ?')
    .run(authentication.authenticationInfo.newCounter, credential.id, credential.counter);
  return updated.changes ? { ok: true } : 403;
}
