// node --test src/guestkeys.test.ts (real HTTP and signed authenticator responses)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { harness } from './harness.ts';
const h = await harness('guestkeys', { env: { CADDY_HOST: '127.0.0.1' } });
const guests = await import('./guests.ts');
const { ORIGIN, PUBLIC_HOST } = await import('./config.ts');
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest();
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const cookieOf = (reply: { headers: Record<string, any> }) => reply.headers['set-cookie'][0].split(';')[0];
let client = 1;
async function visitor(name: string) {
  assert.equal(
    (guests.invite(name, `${name.replaceAll(' ', '').toLowerCase()}@example.com`) as { name: string }).name,
    name,
  );
  const door = guests.doorLink(`guestkeys:${name}`),
    path = new URL(door.url).pathname,
    from = `192.0.2.${client++}`;
  guests.addDoor(link =>
    link === door.link
      ? {
          guest: name,
          open: true,
          words: () => ({ title: 'Notebook', text: 'Your pages', button: 'Open' }),
          go: () => '/guest/notebooks/',
        }
      : undefined,
  );
  const post = (url: string, body: unknown = {}, cookie = '', ip = from) =>
    h.send(url, { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': ip, cookie }, body);
  const form = (step: string, body: Record<string, string>) =>
    h.send(
      `${path}/${step}`,
      { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': from },
      new URLSearchParams(body).toString(),
    );
  const sent = await form('send', {});
  const code = /(?:page from .*?|pagina van .*? te openen): (\d{6})/.exec(sent.text)?.[1];
  assert.ok(code, sent.text);
  const verified = await form('verify', { code });
  assert.equal(verified.status, 303);
  assert.equal((await form('verify', { code })).status, 400);
  return { name, path, post, session: cookieOf(verified), from };
}
function authenticator() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }),
    id = randomBytes(24);
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]),
  );
  const common = {
    id: id.toString('base64url'),
    rawId: id.toString('base64url'),
    type: 'public-key',
    clientExtensionResults: {},
  };
  const auth = (flags: number, counter: number, host = PUBLIC_HOST) => {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    return Buffer.concat([digest(host), Buffer.from([flags]), count]);
  };
  return {
    register(challenge: string) {
      const size = Buffer.alloc(2);
      size.writeUInt16BE(id.length);
      const authData = Buffer.concat([auth(0x45, 0), Buffer.alloc(16), size, id, cose]);
      const attestation = isoCBOR.encode(
        new Map<string, string | Uint8Array | Map<string, never>>([
          ['fmt', 'none'],
          ['attStmt', new Map<string, never>()],
          ['authData', authData],
        ]),
      );
      return {
        ...common,
        response: {
          clientDataJSON: encoded({ type: 'webauthn.create', challenge, origin: ORIGIN }),
          attestationObject: Buffer.from(attestation).toString('base64url'),
          transports: ['internal'],
        },
      };
    },
    login(challenge: string, counter = 1, origin = ORIGIN, flags = 0x05, host = PUBLIC_HOST) {
      const clientDataJSON = encoded({ type: 'webauthn.get', challenge, origin }),
        authenticatorData = auth(flags, counter, host);
      const signature = sign(
        'sha256',
        Buffer.concat([authenticatorData, digest(Buffer.from(clientDataJSON, 'base64url'))]),
        privateKey,
      );
      return {
        ...common,
        response: {
          clientDataJSON,
          authenticatorData: authenticatorData.toString('base64url'),
          signature: signature.toString('base64url'),
        },
      };
    },
  };
}
async function enroll(person: Awaited<ReturnType<typeof visitor>>, key: ReturnType<typeof authenticator>) {
  const options = await person.post('/guest/passkeys/enroll/options', {}, person.session);
  assert.equal(options.status, 200);
  assert.equal(options.json.authenticatorSelection.userVerification, 'required');
  const cookie = `${person.session}; ${cookieOf(options)}`;
  assert.equal(
    (await person.post('/guest/passkeys/enroll/verify', key.register(options.json.challenge), cookie)).status,
    200,
  );
  assert.equal(
    (await person.post('/guest/passkeys/enroll/verify', key.register(options.json.challenge), cookie)).status,
    403,
  );
}
test('email-verified guests enroll and sign in with a passkey without a board session', async () => {
  const person = await visitor('Passkey Sam'),
    key = authenticator();
  assert.equal((await person.post('/guest/passkeys/enroll/options')).status, 403);
  await enroll(person, key);
  assert.match((await h.send(person.path)).text, /data-guest-passkey="login"/);
  const options = await person.post(`${person.path}/passkey/options`);
  assert.equal(options.json.userVerification, 'required');
  const signed = key.login(options.json.challenge),
    cookie = cookieOf(options);
  const opened = await person.post(`${person.path}/passkey/verify`, signed, cookie);
  assert.equal(opened.status, 200);
  const session = opened.headers['set-cookie'][0];
  assert.match(session, /^g=/);
  assert.match(session, /Path=\/guest\//);
  assert.equal((await h.send(person.path, { cookie: session.split(';')[0] })).status, 200);
  assert.equal((await h.send('/api/notebooks', { cookie: session.split(';')[0] })).status, 401);
  assert.equal((await person.post(`${person.path}/passkey/verify`, signed, cookie)).status, 403);
});
test('passkeys reject wrong origin, RP, user verification, counter, guest and client', async () => {
  const person = await visitor('Passkey Kim'),
    other = await visitor('Passkey Lot');
  const key = authenticator(),
    otherKey = authenticator();
  await enroll(person, key);
  await enroll(other, otherKey);
  for (const args of [
    [1, 'https://outside.example'],
    [1, ORIGIN, 0x01],
    [1, ORIGIN, 0x05, 'outside.example'],
  ]) {
    const options = await person.post(`${person.path}/passkey/options`);
    const signed = key.login(options.json.challenge, ...(args as [number, string?, number?, string?]));
    assert.equal((await person.post(`${person.path}/passkey/verify`, signed, cookieOf(options))).status, 403);
  }
  let options = await other.post(`${other.path}/passkey/options`);
  assert.equal(
    (await other.post(`${other.path}/passkey/verify`, key.login(options.json.challenge), cookieOf(options))).status,
    403,
  );
  options = await person.post(`${person.path}/passkey/options`);
  const signed = key.login(options.json.challenge);
  assert.equal(
    (await person.post(`${person.path}/passkey/verify`, signed, cookieOf(options), '192.0.2.250')).status,
    403,
  );
  assert.equal((await person.post(`${person.path}/passkey/verify`, signed, cookieOf(options))).status, 403);
  options = await person.post(`${person.path}/passkey/options`);
  assert.equal(
    (await person.post(`${person.path}/passkey/verify`, key.login(options.json.challenge), cookieOf(options))).status,
    200,
  );
  options = await person.post(`${person.path}/passkey/options`);
  assert.equal(
    (await person.post(`${person.path}/passkey/verify`, key.login(options.json.challenge), cookieOf(options))).status,
    403,
  );
});
test('changing a guest address ends credentials and pending enrollments', async () => {
  const person = await visitor('Passkey Noor'),
    key = authenticator();
  await enroll(person, key);
  const job = await h.start({ agent: 'bolt', engine: 'claude' });
  const written = guests.write({ id: job.id, agent: job.agent }, person.name, 'Guest key lifecycle', {
    sections: [{ items: [{ kind: 'info', title: 'Your notes' }] }],
  }) as { request: number };
  const pending = await person.post('/guest/passkeys/enroll/options', {}, person.session);
  assert.equal((await h.board('/api/guest/email', { id: written.request, email: 'new.noor@example.com' })).status, 200);
  assert.equal((await person.post(`${person.path}/passkey/options`)).status, 403);
  assert.equal(
    (
      await person.post(
        '/guest/passkeys/enroll/verify',
        key.register(pending.json.challenge),
        `${person.session}; ${cookieOf(pending)}`,
      )
    ).status,
    403,
  );
  assert.equal((await h.board('/api/guest/revoke', { id: written.request, what: 'guest' })).status, 200);
  assert.equal((await person.post(`${person.path}/passkey/options`)).status, 403);
  assert.equal((await person.post('/guest/passkeys/enroll/options', {}, person.session)).status, 403);
});

test('a revoked guest cannot finish an in-flight passkey sign-in', async () => {
  const person = await visitor('Passkey Vera'),
    key = authenticator();
  await enroll(person, key);
  const options = await person.post(`${person.path}/passkey/options`);
  const job = await h.start({ agent: 'wren', engine: 'claude' });
  const written = guests.write({ id: job.id, agent: job.agent }, person.name, 'Revoke the guest', {
    sections: [{ items: [{ kind: 'info', title: 'Your notes' }] }],
  }) as { request: number };
  assert.equal((await h.board('/api/guest/revoke', { id: written.request, what: 'guest' })).status, 200);
  assert.equal(
    (await person.post(`${person.path}/passkey/verify`, key.login(options.json.challenge), cookieOf(options))).status,
    403,
  );
  assert.equal((await person.post(`${person.path}/passkey/options`)).status, 403);
  assert.equal((await person.post('/guest/passkeys/enroll/options', {}, person.session)).status, 403);
});

test('a passkey challenge expires after five minutes', async context => {
  const person = await visitor('Passkey Bram'),
    key = authenticator();
  await enroll(person, key);
  const options = await person.post(`${person.path}/passkey/options`);
  context.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  context.mock.timers.tick(5 * 60_000 + 1);
  assert.equal(
    (await person.post(`${person.path}/passkey/verify`, key.login(options.json.challenge), cookieOf(options))).status,
    403,
  );
});
