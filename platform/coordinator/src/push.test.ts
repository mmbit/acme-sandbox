// node --test src/push.test.ts   (the board's devices, played by local servers that decrypt what reaches them as a
// browser would: subscribed and rung through HQ's routes)
import { mock, test } from 'node:test';
import { writeFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { harness } from './harness.ts';

const h = await harness('push');
const { board } = h;
const { subtle } = globalThis.crypto;
const b64 = (s: string) => Buffer.from(s, 'base64url');

// The example in RFC 8291, appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

// A receiving browser, written against WebCrypto rather than the node:crypto calls push.ts uses.
async function decrypt(body: Buffer, uaPublic: Buffer, uaPrivate: Buffer, auth: Buffer) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], as = body.subarray(21, 21 + idlen);
  assert.equal(rs, 4096);
  const jwk = { kty: 'EC', crv: 'P-256', d: uaPrivate.toString('base64url'),
    x: uaPublic.subarray(1, 33).toString('base64url'), y: uaPublic.subarray(33).toString('base64url') };
  const priv = await subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = await subtle.importKey('raw', as, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hkdf = async (ikm: ArrayBuffer | Uint8Array, s: Uint8Array, info: Uint8Array, bits: number) =>
    subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), bits);
  const enc = (s: string) => new TextEncoder().encode(s);
  const ikm = await hkdf(secret, auth, Buffer.concat([enc('WebPush: info\0'), uaPublic, as]), 256);
  const cek = await hkdf(ikm, salt, enc('Content-Encoding: aes128gcm\0'), 128);
  const iv = await hkdf(ikm, salt, enc('Content-Encoding: nonce\0'), 96);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv }, key, body.subarray(21 + idlen)));
  assert.equal(padded.at(-1), 2, 'last-record delimiter');
  return padded.subarray(0, -1).toString();
}

// A device: a push service that takes what HQ sends to it (or answers 410, gone) and reads it as the browser would.
async function device(path: string, status = 201) {
  const got: { headers: any; msg: any }[] = [];
  const srv = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
    got.push({ headers: req.headers, msg: JSON.parse(await decrypt(Buffer.concat(chunks), b64(RFC.uaPublic), b64(RFC.uaPrivate), b64(RFC.auth))) });
    res.writeHead(status).end();
  });
  await new Promise<void>(r => srv.listen(0, r));
  test.after(() => srv.close());
  const origin = `http://localhost:${(srv.address() as any).port}`, endpoint = `${origin}/${path}`;
  assert.equal((await board('/api/push/subscribe', { endpoint, keys: { p256dh: RFC.uaPublic, auth: RFC.auth } })).status, 200);
  const close = async () => { await board('/api/push/unsubscribe', { endpoint }); srv.close(); };
  return { got, origin, endpoint, close, bodies: () => got.map(g => g.msg.body).sort() };
}
const settle = () => new Promise(r => setTimeout(r, 300));
const devices = async () => (await board('/api/push/key')).body.devices as number;

test("what reaches a device is aes128gcm a browser's WebCrypto reads, with an ES256 VAPID JWT for its push service, signed by the key HQ hands out", async () => {
  assert.equal(await decrypt(b64(RFC.body), b64(RFC.uaPublic), b64(RFC.uaPrivate), b64(RFC.auth)), RFC.plaintext, '(the stand-in browser reads the RFC example)');
  const phone = await device('a');
  assert.deepEqual((await board('/api/push/test', { endpoint: phone.endpoint })).body, { sent: 1, pruned: 0, failed: 0 });
  const [{ headers, msg }] = phone.got;
  assert.equal(headers['content-encoding'], 'aes128gcm');
  assert.equal(msg.tag, 'hq-test');
  const [, jwt, k] = headers.authorization.match(/^vapid t=([^,]+), k=(.+)$/)!;
  assert.equal(k, (await board('/api/push/key')).body.key);
  const [head, claims, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(b64(head).toString()), { typ: 'JWT', alg: 'ES256' });
  const c = JSON.parse(b64(claims).toString());
  assert.equal(c.aud, phone.origin);
  assert.ok(c.exp > Date.now() / 1000 && c.exp <= Date.now() / 1000 + 3600);
  assert.match(c.sub, /^(mailto:|https:)/);
  const key = await subtle.importKey('raw', b64(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64(sig), new TextEncoder().encode(`${head}.${claims}`)));
  await phone.close();
});

test('subscriptions are validated, rung, and pruned when gone; only urgent cards and sign-ins ring', async () => {
  const keys = { p256dh: RFC.uaPublic, auth: RFC.auth };
  assert.equal((await board('/api/push/subscribe', { endpoint: 'ftp://x', keys })).status, 400);
  assert.equal((await board('/api/push/subscribe', { endpoint: 'http://localhost:1/a', keys: { p256dh: 'short', auth: RFC.auth } })).status, 400);
  const phone = await device('live'), gone = await device('gone', 410);
  assert.equal(await devices(), 2);
  assert.deepEqual((await board('/api/push/test', {})).body, { sent: 1, pruned: 1, failed: 0 });
  assert.equal(await devices(), 1);

  phone.got.length = 0;
  const kit = await h.start({ agent: 'kit' });
  const ask = (kind: string, title: string, urgency: string) => h.agent('request', kit.token, { kind, title, body: 'Which?', urgency });
  await ask('decision', 'Pick a mug colour', 'today');
  await ask('action', 'Top up the ads', 'now');
  h.jobs.createRequest({ kind: 'login', seat: 'codex-1', title: 'Sign in', body: 'Open https://example.com' });
  await settle();
  assert.equal(phone.got.length, 2);
  assert.ok(phone.got.every(g => g.headers.topic === 'desk-phone' && g.headers.ttl === String(6 * 3600)));
  assert.ok(phone.got.some(g => g.msg.body === 'Top up the ads'));
  await h.finish(kit);
  await phone.close();
  await gone.close();
  assert.equal(await devices(), 0);
});

test('the VAPID key pair is made once and kept across a restart', async () => {
  // @ts-expect-error the query makes a fresh copy of the module, a path TypeScript can't resolve
  const again: typeof import('./push.ts') = await import('./push.ts?restart');
  assert.equal(again.publicKey, (await board('/api/push/key')).body.key);
});

// ---- what work on a thread with a board deadline rings (jobs.ts createRequest)
const HOUR = 3600_000;

test("a card from work on a thread with a deadline rings, whatever urgency its agent gave it; other work's waits", async () => {
  const phone = await device('cards');
  const due = await h.start({ agent: 'bolt', title: 'The invite fix', queuedBy: 'juno', thread: h.dueThread({ deadline: Date.now() + 2 * HOUR }) });
  const plain = await h.start({ agent: 'bolt', title: 'Tidy the readme' });
  // a fix on the deadline work's pull request: on its thread, so the same deadline
  const fix = await h.start({ agent: 'bolt', title: 'Fixing review notes', branch: `job/${due.id}` });
  // (as soon as it can: a deadline of now.)
  const rushed = await h.start({ agent: 'bolt', title: 'The login fix', thread: h.dueThread({ deadline: Date.now() }) });
  const card = async (job: typeof due, title: string, urgency?: string) => (await h.agent('request', job.token, { kind: 'decision', title, body: 'x', urgency })).body.id;
  const asked = [await card(due, 'Which wording?', 'today'), await card(fix, 'Keep the old link?'), await card(plain, 'Which font?', 'today'),
    await card(rushed, 'Which login page?', 'today')];
  await settle();
  const cards = (await board('/api/requests')).body as { id: number; urgency: string }[];
  assert.deepEqual(asked.map(id => cards.find(c => c.id === id)!.urgency), ['now', 'now', 'today', 'now']);
  assert.deepEqual(phone.bodies(), ['Keep the old link?', 'Which login page?', 'Which wording?']);
  for (const j of [due, plain, fix, rushed]) await h.finish(j);
  await phone.close();
});

test('seat warnings start off, take company defaults, and the CEO or Process replaces them through hq', async () => {
  const boss = await h.start({ agent: 'juno' });
  const processJob = await h.start({ agent: 'bolt' });
  const other = await h.start({ agent: 'kit' });
  const read = async () => JSON.parse((await h.hq(boss, 'seat-warning')).out).warning;
  assert.equal(await read(), null);
  const file = `${h.repo}/company/seats.yaml`;
  writeFileSync(file, 'warning:\n  week: { percent: 90, hours: 0 }\n');
  assert.deepEqual(await read(), { week: { percent: 90, hours: 0 } });
  assert.equal((await h.hq(other, 'seat-warning', 'off')).code, 1);
  assert.equal((await h.hq(processJob, 'seat-warning', '--week-percent', '85', '--five-hour-hours', '2')).code, 0);
  assert.deepEqual(await read(), { week: { percent: 85 }, five_hour: { hours: 2 } });
  for (const warning of [{ week: { percent: 101 } }, { week: { hours: -1 } }, {}, { week: { typo: 3 } }])
    assert.equal((await h.agent('seat-warnings', boss.token, { warning })).status, 400);
  assert.equal((await h.hq(boss, 'seat-warning', '--week-percent', 'garbage')).code, 1);
  assert.deepEqual(await read(), { week: { percent: 85 }, five_hour: { hours: 2 } });
  assert.equal((await h.hq(boss, 'seat-warning', 'off')).code, 0);
  assert.equal(await read(), null, 'off overrides company defaults');
  rmSync(file);
  for (const job of [boss, processJob, other]) await h.finish(job);
});

test('usage crossings push once per seat to every device, survive missing readings and restart, and rearm below the level or after reset', async () => {
  const phone = await device('seat-phone'), tablet = await device('seat-tablet');
  const boss = await h.start({ agent: 'juno' });
  const t0 = Date.now(), reset = t0 + 24 * HOUR;
  const report = (seat: string, week?: number, util?: number, resets = reset) =>
    h.worker('seat', { seat, engine: 'claude', state: 'ready', week, util, weekResets: resets, resets });
  await report('claude-warning', 0.99, 0.99);
  await settle();
  assert.equal(phone.got.length, 0, 'off is silent');
  await h.agent('seat-warnings', boss.token, { warning: { week: { percent: 58 }, five_hour: { percent: 80 } } });
  await report('claude-warning', 0.57, 0.79);
  await report('claude-warning', 0.58, 0.80);
  await settle();
  assert.equal(phone.got.length, 1, 'both crossings share one push');
  assert.equal(tablet.got.length, 1);
  const message = phone.got[0].msg;
  assert.match(message.body, /claude-warning: week 42% left/);
  assert.match(message.body, /5-hour window 20% left/);
  assert.match(message.body, /run-out time unknown/);
  const { companyTime } = await import('./company.ts');
  assert.ok(message.body.includes(companyTime(reset)));
  await report('claude-warning', 0.59, 0.81);
  await report('claude-warning');
  await report('claude-warning', 0.59, 0.81);
  // @ts-expect-error a fresh module uses the same durable crossing state
  const restarted = await import('./seatwarning.ts?restart');
  restarted.checkSeatWarning('claude-warning');
  await settle();
  assert.equal(phone.got.length, 1);
  await report('claude-warning-b', 0.59, 0.81);
  await settle();
  assert.equal(phone.got.length, 2);
  assert.notEqual(phone.got[0].headers.topic, phone.got[1].headers.topic);
  await report('claude-warning', 0.57, 0.79);
  await report('claude-warning', 0.60, 0.82);
  await report('claude-warning', 0.61, 0.83, reset + 7 * 24 * HOUR);
  await settle();
  assert.equal(phone.got.length, 4);
  assert.equal(tablet.got.length, 4);
  await h.worker('seat', { seat: 'claude-unknown-reset', engine: 'claude', state: 'ready', week: 0.95 });
  await report('claude-unknown-reset', 0.95, undefined);
  await settle();
  assert.equal(phone.got.length, 5, 'learning the reset time does not recross the usage level');
  await report('claude-expired', 0.95, 0.95, t0 - HOUR);
  await settle();
  assert.equal(phone.got.length, 5, 'expired quota readings are not warnings');
  await h.agent('seat-warnings', boss.token, { warning: null });
  await h.finish(boss);
  await phone.close();
  await tablet.close();
});

test('lead warnings use measured headroom per active agent-hour and only forecast exhaustion before reset', async () => {
  const phone = await device('seat-projection');
  const boss = await h.start({ agent: 'juno' });
  const t0 = Math.floor(Date.now() / HOUR) * HOUR;
  mock.timers.enable({ apis: ['Date'], now: t0 });
  try {
    const report = (seat: string, week: number, util: number, reset = t0 + 12 * HOUR) =>
      h.worker('seat', { seat, engine: 'claude', state: 'ready', week, util, weekResets: reset, resets: t0 + 5 * HOUR });
    await h.agent('seat-warnings', boss.token, { warning: { week: { hours: 2 }, five_hour: { hours: 0.5 } } });
    await report('claude-forecast', 0.2, 0.1);
    const first = await h.start({ agent: 'bolt' }, { seat: 'claude-forecast' });
    const second = await h.start({ agent: 'kit' }, { seat: 'claude-forecast' });
    mock.timers.setTime(t0 + HOUR);
    await report('claude-forecast', 0.4, 0.3);
    await settle();
    assert.equal(phone.got.length, 0, 'exhaustion is still three hours away');
    mock.timers.setTime(t0 + 2 * HOUR);
    await h.heartbeat(boss);
    await report('claude-forecast', 0.6, 0.5);
    await settle();
    assert.equal(phone.got.length, 1, 'two active runs exhaust the remaining week in two hours');
    const { companyTime } = await import('./company.ts');
    assert.ok(phone.got[0].msg.body.includes(companyTime(t0 + 4 * HOUR)));
    await report('claude-forecast', 0.6, 0.5);
    await settle();
    assert.equal(phone.got.length, 1);
    await h.finish(first);
    await h.finish(second);
    await report('claude-forecast', 0.6, 0.5);
    const resumedFirst = await h.start({ agent: 'bolt' }, { seat: 'claude-forecast' });
    const resumedSecond = await h.start({ agent: 'kit' }, { seat: 'claude-forecast' });
    await report('claude-forecast', 0.6, 0.5);
    await settle();
    assert.equal(phone.got.length, 1, 'an idle reading does not rearm the same forecast threshold');
    await h.finish(resumedFirst);
    await h.finish(resumedSecond);
    const continued = await h.start({ agent: 'bolt' }, { seat: 'claude-forecast' });
    await report('claude-forecast', 0.6, 0.5);
    assert.equal((await h.agent('seat-warnings', boss.token, { warning: { week: { hours: 0 }, five_hour: { hours: 0.5 } } })).status, 200);
    await report('claude-forecast', 0.6, 0.5);
    await settle();
    assert.equal(phone.got.length, 2, 'zero warns on any measured run-out before reset, even more than two hours away');
    await h.finish(continued);
    await report('claude-short', 0.1, 0.1, t0 + 4 * HOUR);
    const third = await h.start({ agent: 'bolt' }, { seat: 'claude-short' });
    mock.timers.setTime(t0 + 3 * HOUR);
    await report('claude-short', 0.2, 0.9, t0 + 4 * HOUR);
    await settle();
    assert.equal(phone.got.length, 3, 'the five-hour window is close to exhaustion, the week resets first');
    assert.match(phone.got[2].msg.body, /5-hour window 10% left/);
    assert.ok(!phone.got[2].msg.body.includes('week '));
    await h.finish(third);
  } finally {
    mock.timers.reset();
    await h.agent('seat-warnings', boss.token, { warning: null });
    await h.finish(boss);
    await phone.close();
  }
});

test('a percentage-only warning still includes the measured exhaustion forecast', async () => {
  const phone = await device('seat-percent-projection');
  const boss = await h.start({ agent: 'juno' });
  const t0 = Math.floor(Date.now() / HOUR) * HOUR;
  mock.timers.enable({ apis: ['Date'], now: t0 });
  try {
    assert.equal((await h.agent('seat-warnings', boss.token, { warning: { week: { percent: 60 } } })).status, 200);
    const report = (week: number) => h.worker('seat', {
      seat: 'claude-percent', engine: 'claude', state: 'ready', week, weekResets: t0 + 12 * HOUR,
    });
    await report(0.5);
    const working = await h.start({ agent: 'bolt' }, { seat: 'claude-percent' });
    mock.timers.setTime(t0 + HOUR);
    await report(0.6);
    await settle();
    assert.equal(phone.got.length, 1);
    const { companyTime } = await import('./company.ts');
    assert.ok(phone.got[0].msg.body.includes(companyTime(t0 + 5 * HOUR)));
    await report(0.6);
    await settle();
    assert.equal(phone.got.length, 1);
    await h.finish(working);
  } finally {
    mock.timers.reset();
    await h.agent('seat-warnings', boss.token, { warning: null });
    await h.finish(boss);
    await phone.close();
  }
});
