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

db.exec(`create table if not exists guest_credentials (
  id text primary key, guest text not null collate nocase, public_key blob not null,
  counter integer not null, transports text not null, created text not null);
  create table if not exists guest_challenges (
    key text primary key, guest text not null collate nocase, email text not null,
    purpose text not null, scope text not null, session text not null, client text not null,
    challenge text not null, expires integer not null)`);

type Identity = { name: string; email: string | null };
type Context = Identity & { scope: string; session: string };
type Credential = { id: string; guest: string; public_key: Uint8Array; counter: number; transports: string };
type Challenge = Context & { guest: string; purpose: string; client: string; challenge: string; expires: number };
const CHALLENGE_MS = 5 * 60_000,
  PER_CLIENT = 5,
  MAX_PENDING = 2000;
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
const WEBAUTHN = new URL('../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js', import.meta.url);
type FindIdentity = (enroll: boolean, token: string) => Context | null;
type StartSession = (name: string) => { 'set-cookie': string };
export async function page(req: IncomingMessage, res: ServerResponse, find: FindIdentity, start: StartSession) {
  const path = new URL(req.url ?? '/', ORIGIN).pathname;
  if (req.method === 'GET' && ['/guest/guestkeys.js', '/guest/webauthn.js'].includes(path)) {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' });
    res.end(path.endsWith('/guestkeys.js') ? SCRIPT : readFileSync(WEBAUTHN));
    return true;
  }
  const match = /^\/guest\/(passkeys\/enroll|[A-Za-z0-9_-]{43}\/passkey)\/(options|verify)$/.exec(path);
  if (!match) return false;
  if (req.method !== 'POST' || req.headers.origin !== ORIGIN) return respond(res, 403, { error: 'origin' });
  const enroll = match[1] === 'passkeys/enroll',
    token = match[1].split('/')[0];
  const before = find(enroll, token);
  if (!before) return respond(res, 403, { error: 'guest' });
  const body = await readBody(req);
  if ('status' in body) return respond(res, body.status, { error: 'body' });
  const person = find(enroll, token);
  if (!person || person.name !== before.name || person.email !== before.email)
    return respond(res, 403, { error: 'guest' });
  const answer =
    match[2] === 'options' ? await options(req, res, person, enroll) : await verify(req, person, enroll, body.value);
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
async function readBody(req: IncomingMessage): Promise<{ value: unknown } | { status: number }> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) return { status: 413 };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { status: 400 };
  }
}

export const has = (guest: string) => keys(guest).length > 0;
export function forget(guest: string) {
  db.prepare('delete from guest_credentials where guest = ?').run(guest);
  db.prepare('delete from guest_challenges where guest = ?').run(guest);
}

export async function options(req: IncomingMessage, res: ServerResponse, identity: Context, enroll: boolean) {
  if (!live(identity)) return 403;
  if (
    enroll &&
    !db
      .prepare('select 1 from guest_sessions where hash = ? and guest = ? and expires > ?')
      .get(identity.session, identity.name, Date.now())
  )
    return 403;
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
  db.prepare('delete from guest_challenges where expires <= ?').run(Date.now());
  const pending = db.prepare('select key from guest_challenges where client = ? order by rowid').all(client) as {
    key: string;
  }[];
  if (pending.length >= PER_CLIENT) db.prepare('delete from guest_challenges where key = ?').run(pending[0].key);
  if ((db.prepare('select count(*) n from guest_challenges').get() as { n: number }).n >= MAX_PENDING) return false;
  const token = randomBytes(32).toString('base64url');
  db.prepare(
    `insert into guest_challenges (key, guest, email, purpose, scope, session, client, challenge, expires)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sha256(token),
    identity.name,
    identity.email,
    purpose,
    identity.scope,
    identity.session,
    client,
    challenge,
    Date.now() + CHALLENGE_MS,
  );
  res.appendHeader(
    'set-cookie',
    `guest-passkey=${token}; Path=/guest/; HttpOnly; SameSite=Strict; Max-Age=300${secure}`,
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
  const key = sha256(token);
  const pending = db.prepare('delete from guest_challenges where key = ? returning *').get(key) as
    Challenge | undefined;
  if (
    !pending ||
    pending.expires <= Date.now() ||
    pending.purpose !== purpose ||
    pending.client !== client ||
    pending.guest.toLowerCase() !== identity.name.toLowerCase() ||
    pending.email !== identity.email ||
    pending.scope !== identity.scope ||
    pending.session !== identity.session ||
    !live(identity)
  )
    return;
  if (
    purpose === 'enroll' &&
    !db
      .prepare('select 1 from guest_sessions where hash = ? and guest = ? and expires > ?')
      .get(identity.session, identity.name, Date.now())
  )
    return;
  return pending;
}

async function register(identity: Context, challenge: string, response: any) {
  let registration;
  try {
    registration = await verifyRegistrationResponse({ response, expectedChallenge: challenge, ...rp });
  } catch {
    // Authenticator replies are untrusted and contain credential material that never goes to logs.
    return 403;
  }
  if (!registration.verified || !registration.registrationInfo || !live(identity)) return 403;
  if (
    !db
      .prepare('select 1 from guest_sessions where hash = ? and guest = ? and expires > ?')
      .get(identity.session, identity.name, Date.now())
  )
    return 403;
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
