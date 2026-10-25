// node --test src/photos.test.ts   (the real server on a local port, a throwaway DATA_DIR, a fake shop and a fake HQ, and
// the local ImageMagick with our policy). A claim's photos: a PNG renamed .jpg, a JPEG
// with something after its end, a 50000 × 50000 header, a JPEG with GPS in its EXIF; the limits; the route's gate; the
// push to HQ and the retention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { createHash } from 'node:crypto';
import { jpegSize } from '../../../shared/pictures/size.ts';

const TOKEN = 'photos-test-token';
const VIEW = { id: 'ORD-7Q4K-M2', ref: '1735', placed_at: '2026-09-24T10:00:00Z', title: '“Mila” mug', status: 'delivered',
  shipped_at: '2026-09-28T09:00:00Z', delivered_at: null, carrier: 'Royal Mail', tracking_url: null, country: 'GB' };
const shop = createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d).on('end', () => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
    const b = JSON.parse(body);
    if (req.url === '/api/care/orders') return void res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ orders: b.email === 'anna@example.com' ? [VIEW, { ...VIEW, id: 'ORD-ANNA-02' }] : [] }));
    res.writeHead(404).end();
  });
});
await new Promise<void>(r => shop.listen(0, '127.0.0.1', r));

// HQ's side: the photos care pushes (query, headers, bytes), and the cards and state hq.ts asks for
const got: { url: URL; type: string; auth: string; bytes: Buffer }[] = [];
let hqDown = false;
const hqServer = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', d => chunks.push(d)).on('end', () => {
    const url = new URL(req.url!, 'http://hq');
    if (url.pathname === '/api/care/photos') {
      if (hqDown) return void res.writeHead(503).end();
      got.push({ url, type: String(req.headers['content-type']), auth: String(req.headers.authorization), bytes: Buffer.concat(chunks) });
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(url.pathname === '/api/care/state' ? { busy: 'auto', queue: { waiting: 0, oldest: null } } : { ok: true, id: '1' }));
  });
});
await new Promise<void>(r => hqServer.listen(0, '127.0.0.1', r));

const PORT = 20000 + Math.floor(Math.random() * 20000);
const DATA = mkdtempSync(join(tmpdir(), 'care-photos-'));
Object.assign(process.env, { DATA_DIR: DATA, PORT: String(PORT), CARE_LOCAL: '1', CARE_PROVIDER: 'fake', CARE_UPLOAD_MS: '1500',
  CARE_APPS: JSON.stringify({ shop: `http://127.0.0.1:${(shop.address() as any).port}` }), CARE_TOKENS: JSON.stringify({ shop: TOKEN }),
  CARE_NAMES: JSON.stringify({ shop: 'Shop' }), CARE_THINGS: JSON.stringify({ shop: 'mug' }),
  CARE_COMPANY_DIR: new URL('../../../template/products/care', import.meta.url).pathname,
  CARE_HQ_URL: `http://127.0.0.1:${(hqServer.address() as any).port}`, CARE_HQ_TOKEN: 'hq-test-token' });
const { db, now } = await import('./db.ts');
const engine = await import('./engine.ts');
const photos = await import('./photos.ts');
const { t } = await import('./texts.ts');
await import('./server.ts');
await new Promise(r => setTimeout(r, 100));

// ---- pictures, made by the local ImageMagick without our policy (the test's own tool, not the decoder under test)
// Both keep ImageMagick's temporary files in the test's TMPDIR
const BIN = ['magick', 'convert'].find(n => String(process.env.PATH).split(delimiter).some(d => existsSync(join(d, n))))!;
const make = (args: string[]) => execFileSync(BIN, args, { maxBuffer: 64 << 20, env: { PATH: process.env.PATH, MAGICK_TEMPORARY_PATH: tmpdir() } });
const JPEG = make(['-size', '64x48', 'gradient:red-blue', '-quality', '80', 'jpeg:-']);
const PNG = make(['-size', '64x48', 'gradient:red-blue', 'png:-']);
// An EXIF APP1 segment, big-endian: Orientation 6 (turn 90° to view) and a GPS IFD with latitude N 52° 22′ 43.21″
const LAT = Buffer.from([0, 0, 0, 52, 0, 0, 0, 1, 0, 0, 0, 22, 0, 0, 0, 1, 0, 0, 0x10, 0xe1, 0, 0, 0, 100]);
function exif(orientation: number) {
  const t = Buffer.alloc(92); t.write('MM', 0, 'latin1'); t.writeUInt16BE(42, 2); t.writeUInt32BE(8, 4);
  t.writeUInt16BE(2, 8);
  t.writeUInt16BE(0x0112, 10); t.writeUInt16BE(3, 12); t.writeUInt32BE(1, 14); t.writeUInt16BE(orientation, 18);
  t.writeUInt16BE(0x8825, 22); t.writeUInt16BE(4, 24); t.writeUInt32BE(1, 26); t.writeUInt32BE(38, 30);
  t.writeUInt32BE(0, 34);
  t.writeUInt16BE(2, 38);
  t.writeUInt16BE(0x0001, 40); t.writeUInt16BE(2, 42); t.writeUInt32BE(2, 44); t.write('N\0', 48, 'latin1');
  t.writeUInt16BE(0x0002, 52); t.writeUInt16BE(5, 54); t.writeUInt32BE(3, 56); t.writeUInt32BE(68, 60);
  t.writeUInt32BE(0, 64);
  LAT.copy(t, 68);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]);
  const seg = Buffer.from([0xff, 0xe1, 0, 0]); seg.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([seg, body]);
}
const withExif = (j: Buffer) => Buffer.concat([j.subarray(0, 2), exif(6), j.subarray(2)]);
// a header that says width × height, and nothing to decode behind it (a decompression bomb's first bytes)
function bomb(width: number, height: number) {
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}
const spy = () => { const calls: Buffer[] = []; const f = async (b: Buffer) => { calls.push(b); return photos.reencode(b, jpegSize(b)!); }; return Object.assign(f, { calls }); };

// ---- a customer with a claim waiting for photos (what remedies.ts sets when claim_check asks for them)
const BASE = `http://127.0.0.1:${PORT}`;
const CLAIM = { order: 'ORD-7Q4K-M2', kind: 'damaged', shots: ['box', 'label', 'box_damage', 'product', 'closeup'] };
async function customer({ orders = [CLAIM.order], email = null as string | null, claim = CLAIM as any } = {}) {
  const ip = `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, tab = crypto.randomUUID();
  const r = await fetch(`${BASE}/__care/api/hello`, { method: 'POST', headers: { 'x-care-app': 'shop', origin: BASE, 'content-type': 'application/json', 'x-forwarded-for': ip, 'x-care-tab': tab }, body: '{"lang":"en"}' });
  const cookie = r.headers.getSetCookie()[0].split(';')[0];
  const sid = createHash('sha256').update(cookie.slice('__Host-care='.length)).digest('hex');
  const t = now();
  db.prepare('update sessions set orders = ?, email = ?, email_at = ?, email_seen = ? where id = ?').run(JSON.stringify(orders), email, email && t, email && t, sid);
  const conv = (db.prepare('select conversation from sessions where id = ?').get(sid) as any).conversation as number;
  const l = engine.live(conv)!;
  if (claim) { l.conv.state.claim = claim; l.save(); }
  const send = (shot: string, bytes: Buffer, extra: Record<string, string> = {}, widget = '') => fetch(`${BASE}/__care/api/photo?shot=${shot}&id=p${Math.random().toString(36).slice(2, 8)}${widget ? `&widget=${widget}` : ''}`,
    { method: 'POST', headers: { 'x-care-app': 'shop', origin: BASE, 'content-type': 'image/jpeg', 'x-forwarded-for': ip, 'x-care-tab': tab, cookie, ...extra }, body: bytes });
  const headers = { 'x-care-app': 'shop', origin: BASE, 'content-type': 'image/jpeg', 'x-forwarded-for': ip, 'x-care-tab': tab, cookie };
  return { conv, l, ip, send, headers };
}
const rows = (conv: number) => db.prepare('select * from photos where conversation = ? order by created, id').all(conv) as any[];
const file = (id: string) => join(DATA, 'photos', `${id}.jpg`);
const base = (conversation: number, claim = CLAIM) => ({ app: 'shop', conversation, claim: claim as any, ip: `10.2.0.${conversation % 250}` });

test('anything but a JPEG is refused before a decoder runs: a PNG renamed .jpg, a JPEG with a script after its end', async () => {
  const { conv } = await customer();
  const d = spy();
  assert.deepEqual(await photos.accept({ ...base(conv), shot: 'box', bytes: PNG }, d), { ok: false, status: 415, why: 'type' });
  const trailing = Buffer.concat([JPEG, Buffer.from('<script>alert(1)</script>')]);
  assert.deepEqual(await photos.accept({ ...base(conv), shot: 'box', bytes: trailing }, d), { ok: false, status: 415, why: 'type' });
  assert.equal(d.calls.length, 0);
  assert.equal(rows(conv).length, 0);
  // and our policy refuses any other coder, even if a PNG ever reached the decoder
  await assert.rejects(photos.reencode(PNG, { width: 64, height: 48 }));
});

// The decoder with our policy, as photos.ts runs it but with another input coder
// named: the policy itself refuses it (the test above can't tell, since `jpeg:-` makes any other format fail anyway)
const POLICY = new URL('../magick', import.meta.url).pathname;
const DECODER = process.env.CARE_MAGICK || BIN;
const decodes = (input: string, bytes: Buffer) => { try { execFileSync(DECODER, [input, 'jpeg:-'], { input: bytes, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, MAGICK_CONFIGURE_PATH: POLICY, MAGICK_TEMPORARY_PATH: tmpdir() } }); return true; } catch { return false; } };

test('our policy refuses every coder but JPEG, whatever the input names, and indirect reads', () => {
  assert.ok(decodes('jpeg:-', JPEG));
  for (const coder of ['png', 'gif', 'mvg', 'msl', 'text', 'txt', 'svg', 'ps', 'pdf', 'html', 'inline']) assert.ok(!decodes(`${coder}:-`, coder === 'png' ? PNG : Buffer.from('push graphic-context\nviewbox 0 0 1 1\npop graphic-context\n')), coder);
  assert.ok(!decodes('@-', Buffer.from('/etc/passwd')));
});

test('a progressive JPEG whose buffers would pass libjpeg\'s memory limit fails in the decoder: 40 MP 4:4:4 from half a megabyte', async () => {
  // libjpeg holds a progressive file's every coefficient while it decodes, outside ImageMagick's memory resource: about
  // 240 MB here without the policy's max-memory-request, past what the container has beside the service
  const prog = make(['-size', '7700x5190', 'xc:#3366aa', '-type', 'TrueColor', '-quality', '90', '-interlace', 'JPEG', '-sampling-factor', '1x1', 'jpeg:-']);
  assert.ok(prog.length < photos.MAX_BYTES);
  const { conv } = await customer();
  assert.deepEqual(await photos.accept({ ...base(conv), shot: 'box', bytes: prog }), { ok: false, status: 422, why: 'decode' });
  // the same picture as 4:2:0 still decodes (a 40 MP photo from a camera that writes progressive files)
  const ok = make(['-size', '7700x5190', 'xc:#3366aa', '-type', 'TrueColor', '-quality', '90', '-interlace', 'JPEG', '-sampling-factor', '2x2', 'jpeg:-']);
  assert.ok((await photos.accept({ ...base(conv), shot: 'label', bytes: ok })).ok);
});

test('more than 3 MB, or a header claiming 50000 × 50000 (or 65535 × 65535), is refused before decoding', async () => {
  const { conv } = await customer();
  const d = spy();
  const big = Buffer.concat([JPEG.subarray(0, -2), Buffer.alloc(photos.MAX_BYTES), Buffer.from([0xff, 0xd9])]);
  assert.deepEqual(await photos.accept({ ...base(conv), shot: 'box', bytes: big }, d), { ok: false, status: 413, why: 'size' });
  for (const [w, h] of [[50000, 50000], [65535, 65535], [16001, 100], [8000, 6000]])
    assert.deepEqual(await photos.accept({ ...base(conv), shot: 'box', bytes: bomb(w, h) }, d), { ok: false, status: 413, why: 'pixels' }, `${w}x${h}`);
  assert.deepEqual(await photos.accept({ ...base(conv), shot: 'box', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }, d), { ok: false, status: 413, why: 'pixels' }); // no frame header at all
  assert.equal(d.calls.length, 0);
});

test('a JPEG with GPS in its EXIF comes out a fresh JPEG: upright, no EXIF, no GPS, under a new random id, 0600', async () => {
  const { conv } = await customer();
  const src = withExif(JPEG);
  assert.ok(src.includes(LAT) && src.includes('Exif'));
  const r = await photos.accept({ ...base(conv), shot: 'label', bytes: src });
  assert.ok(r.ok);
  assert.match(r.id, /^[\w-]{32}$/);
  const out = readFileSync(file(r.id));
  assert.deepEqual([...out.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.ok(!out.includes('Exif') && !out.includes(LAT) && !out.includes(Buffer.from([0xff, 0xe1])), 'no APP1, no EXIF, no GPS');
  assert.deepEqual(photos.segments(out), [0xe0]); // JFIF's header only
  assert.deepEqual(jpegSize(out), { width: 48, height: 64 }); // turned upright before the orientation went
  assert.equal((await import('node:fs')).statSync(file(r.id)).mode & 0o777, 0o600);
  assert.ok(!readdirSync(join(DATA, 'photos')).some(f => !f.endsWith('.jpg')), 'no original kept');
  const row = rows(conv)[0];
  assert.deepEqual([row.order_id, row.kind, row.shot, row.width, row.height, row.bytes], [CLAIM.order, 'damaged', 'label', 48, 64, out.length]);
});

test('a big photo is decoded smaller in the DCT and comes out at most 2560 px long', async () => {
  assert.equal(photos.hint(2560, 1920), null);
  assert.equal(photos.hint(4032, 3024), '2016x1512');  // 1/2
  assert.equal(photos.hint(6000, 4000), '2000x1333');  // 3000 > 2560, so 1/3 (libjpeg: 3/8, 2250 px)
  const { conv } = await customer();
  const big = make(['-size', '3000x1000', 'gradient:red-blue', '-quality', '70', 'jpeg:-']);
  const r = await photos.accept({ ...base(conv), shot: 'product', bytes: big });
  assert.ok(r.ok);
  assert.deepEqual(jpegSize(readFileSync(file(r.id))), { width: 1500, height: 500 });
});

test('a claim is one app\'s order: another app of the shop with an order of the same id has its own slots, count and claim', async () => {
  const { conv } = await customer();
  for (const shot of ['box', 'label']) assert.ok((await photos.accept({ ...base(conv), app: 'other', shot, bytes: JPEG })).ok, shot);
  assert.ok((await photos.accept({ ...base(conv), shot: 'product', bytes: JPEG })).ok);
  assert.deepEqual(photos.filled(conv, 'shop', CLAIM.order, 'damaged'), ['product'], 'not the other app\'s photos');
  assert.deepEqual(photos.filled(conv, 'other', CLAIM.order, 'damaged'), ['box', 'label']);
  const caseId = Number(db.prepare("insert into cases (app, conversation, kind, checked, created) values ('shop', ?, 'claim', 'checked', 1)").run(conv).lastInsertRowid);
  assert.equal(photos.attach(conv, 'shop', CLAIM.order, 'damaged', caseId), 1, 'the claim takes only its own app\'s photo');
  assert.deepEqual(photos.filled(conv, 'other', CLAIM.order, 'damaged', true), ['box', 'label'], 'the other app\'s stay free for its own claim');
});

test('6 photos a case, re-takes included; the 7th is refused before decoding; a re-take replaces the shot', async () => {
  const { conv } = await customer();
  const d = spy();
  for (const shot of ['box', 'label', 'product', 'box', 'box', 'closeup']) assert.ok((await photos.accept({ ...base(conv), shot, bytes: JPEG }, d)).ok, shot);
  assert.deepEqual(photos.filled(conv, 'shop', CLAIM.order, 'damaged'), ['box', 'closeup', 'label', 'product']);
  const boxes = rows(conv).filter(r => r.shot === 'box');
  assert.deepEqual(boxes.map(r => !!r.replaced), [true, true, false]);
  assert.deepEqual(boxes.map(r => existsSync(file(r.id))), [false, false, true]); // a replaced photo's file goes at once
  const n = d.calls.length;
  assert.deepEqual(await photos.accept({ ...base(conv), shot: 'box_damage', bytes: JPEG }, d), { ok: false, status: 429, why: 'case' });
  assert.equal(d.calls.length, n);
  // another case in the same conversation has its own 6
  assert.ok((await photos.accept({ ...base(conv, { ...CLAIM, order: 'ORD-ANNA-02' }), shot: 'box', bytes: JPEG }, d)).ok);
});

test('20 tries a conversation a day, across its cases; the 21st is refused before decoding', async () => {
  const { conv } = await customer();
  const d = spy();
  for (let i = 0; i < 20; i++) {
    const claim = { ...CLAIM, order: `ORD-DAY-${Math.floor(i / 5)}` };
    assert.ok((await photos.accept({ ...base(conv, claim), shot: CLAIM.shots[i % 5], bytes: JPEG }, d)).ok, `photo ${i + 1}`);
  }
  assert.deepEqual(await photos.accept({ ...base(conv, { ...CLAIM, order: 'ORD-DAY-9' }), shot: 'box', bytes: JPEG }, d), { ok: false, status: 429, why: 'day' });
  assert.equal(d.calls.length, 20);
});

test('a shot the claim doesn\'t ask for is refused', async () => {
  const { conv } = await customer();
  assert.deepEqual(await photos.accept({ ...base(conv), shot: 'contents', bytes: JPEG }), { ok: false, status: 400, why: 'shot' });
  assert.deepEqual(await photos.accept({ ...base(conv), shot: '../../etc', bytes: JPEG }), { ok: false, status: 400, why: 'shot' });
});

test('the route: a photo for the claim, and the conversation shows the slot filled in words', async () => {
  const c = await customer();
  const r = await c.send('label', withExif(JPEG));
  assert.equal(r.status, 200);
  const b = await r.json() as any;
  assert.deepEqual([b.ok, b.shot, b.text, b.filled], [true, 'label', '📷 The shipping label', ['label']]);
  const m = db.prepare("select who, text, widget from messages where conversation = ? and who = 'me'").all(c.conv) as any[];
  assert.deepEqual(m.map(x => [x.who, x.text, x.widget]), [['me', '📷 The shipping label', null]]); // words only, never an image
  assert.equal(rows(c.conv).length, 1);
  // with the photos card's id, the card keeps its ticks (a reload, the device's other tabs); a card of another type doesn't
  c.l.store('ai', 'Photos, please.', { widget: { id: 'wph1', type: 'photos', slots: [] } });
  c.l.store('ai', 'A choice.', { widget: { id: 'wch1', type: 'choice', options: [] } });
  const card = (id: string) => JSON.parse((db.prepare('select widget from messages where conversation = ? and widget like ?').get(c.conv, `%"${id}"%`) as any).widget);
  assert.equal((await c.send('product', JPEG, {}, 'wph1')).status, 200);
  assert.deepEqual(card('wph1').ws, { filled: ['label', 'product'] });
  assert.equal((await c.send('box', JPEG, {}, 'wch1')).status, 200);
  assert.equal(card('wch1').ws, undefined);
});

test('the route: the order and case come from the claim; a session that may not see the order, or a shot not asked for, gets nothing', async () => {
  // level 1 for another order: the claim's order isn't one it may see
  const other = await customer({ orders: ['ORD-OTHER-1'] });
  assert.equal((await other.send('box', JPEG)).status, 403);
  // level 2: the order comes from the app's list for the checked email
  const anna = await customer({ orders: [], email: 'anna@example.com', claim: { ...CLAIM, order: 'ORD-ANNA-02' } });
  assert.equal((await anna.send('box', JPEG)).status, 200);
  const bob = await customer({ orders: [], email: 'bob@example.com' });
  assert.equal((await bob.send('box', JPEG)).status, 403);
  // no claim at all, and a shot the claim doesn't ask for
  const none = await customer({ claim: null });
  assert.equal((await none.send('box', JPEG)).status, 409);
  const c = await customer();
  assert.equal((await c.send('contents', JPEG)).status, 400);
  // query parameters can't name the order or the case
  const sneaky = await fetch(`${BASE}/__care/api/photo?shot=box&order=ORD-OTHER-1&kind=misprint`, { method: 'POST', headers: { 'x-care-app': 'shop', origin: BASE, 'content-type': 'image/jpeg' }, body: JPEG });
  assert.equal(sneaky.status, 401);
  for (const x of [other, bob, none, c]) assert.equal(rows(x.conv).length, 0);
});

test('the route: no session, a foreign Origin, another type or too many bytes are refused', async () => {
  const c = await customer();
  const post = (headers: Record<string, string>, body: Buffer = JPEG) => fetch(`${BASE}/__care/api/photo?shot=box`, { method: 'POST', headers: { 'x-care-app': 'shop', ...headers }, body });
  assert.equal((await post({ origin: BASE, 'content-type': 'image/jpeg' })).status, 401); // no cookie
  assert.equal((await c.send('box', JPEG, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await c.send('box', JPEG, { 'content-type': 'application/json' })).status, 415);
  // too many bytes: by Content-Length before reading, and while streaming when there's none (chunked)
  const big = await c.send('box', Buffer.alloc(photos.MAX_BYTES + 1, 0xff)).catch(() => null);
  assert.ok(!big || big.status === 413);
  const chunk = Buffer.alloc(512 * 1024, 0xff); let sent = 0;
  const stream = new ReadableStream({ pull(ctl) { if (sent > photos.MAX_BYTES * 3) return ctl.close(); sent += chunk.length; ctl.enqueue(chunk); } });
  const chunked = await fetch(`${BASE}/__care/api/photo?shot=box`, { method: 'POST', body: stream, duplex: 'half', headers: (c as any).headers } as any).catch(() => null);
  assert.ok(!chunked || chunked.status === 413);
  assert.ok(sent < photos.MAX_BYTES * 3, 'stopped reading at the cut-off');
  assert.equal(rows(c.conv).length, 0);
});

// A body that comes slowly, or never ends, holds its room from before its first
// byte is read until it's done; past the room, the next is refused without reading it.
function slow(c: { headers: Record<string, string> }, length: number, first: number) {
  const req = request(`${BASE}/__care/api/photo?shot=box`, { method: 'POST', headers: { ...c.headers, 'content-length': String(length) } });
  const answer = new Promise<{ status: number; body: any } | null>(ok => {
    req.on('response', r => { let b = ''; r.on('data', d => b += d).on('end', () => ok({ status: r.statusCode!, body: JSON.parse(b || 'null') })); });
    req.on('error', () => ok(null));
  });
  req.flushHeaders();
  if (first) req.write(Buffer.alloc(first, 0xff));
  return { req, answer };
}
const until = async (f: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };

test('a slow body holds its room before it\'s read; past the room the next is refused unread; the room comes back on a hang-up, the time limit or the end', async () => {
  assert.deepEqual(photos.inHand(), { bytes: 0, uploads: 0 });
  const a = await customer(), b = await customer(), other = await customer();
  // two unfinished 3 MB bodies from one address, 2 MB of each sent: both held, by what they declared
  const a1 = slow(a, photos.MAX_BYTES, 2 << 20), a2 = slow(a, photos.MAX_BYTES, 2 << 20);
  await until(() => photos.inHand().uploads === 2);
  assert.deepEqual(photos.inHand(), { bytes: 2 * photos.MAX_BYTES, uploads: 2 });
  // a third from the same address is refused while its body hasn't been sent at all
  const a3 = slow(a, photos.MAX_BYTES, 0);
  assert.equal((await a3.answer)?.status, 503);
  assert.equal((await a3.answer)?.body.why, 'busy');
  // two more from another address fill the budget; then even a small, whole photo from a third is refused unread
  const b1 = slow(b, photos.MAX_BYTES, 1 << 20), b2 = slow(b, photos.MAX_BYTES, 0);
  await until(() => photos.inHand().uploads === 4);
  assert.deepEqual(photos.inHand(), { bytes: 4 * photos.MAX_BYTES, uploads: 4 });
  const full = await other.send('box', JPEG);
  assert.equal(full.status, 503);
  assert.equal(((await full.json()) as any).text, t('photo_busy', 'en'));
  assert.equal(rows(other.conv).length, 0);
  // the first address hangs up: its room comes back, and a normal photo goes through, and lets its room go once stored
  a1.req.destroy(); a2.req.destroy();
  await until(() => photos.inHand().uploads === 2);
  assert.equal(photos.inHand().bytes, 2 * photos.MAX_BYTES);
  assert.equal((await other.send('box', JPEG)).status, 200);
  assert.equal(rows(other.conv).length, 1);
  assert.equal(photos.inHand().uploads, 2);
  // the other two never finish: at the time limit (1.5 s here, a minute in production) they're dropped with a 408
  for (const x of [b1, b2]) assert.equal((await x.answer)?.status, 408);
  assert.deepEqual(photos.inHand(), { bytes: 0, uploads: 0 });
  assert.equal(rows(a.conv).length + rows(b.conv).length, 0);
  // a refusal after the body is read (not a JPEG) lets its room go too
  assert.equal((await other.send('label', PNG)).status, 415);
  assert.deepEqual(photos.inHand(), { bytes: 0, uploads: 0 });
});

test('room by what a body declares: small photos side by side, a chunked one as 3 MB, never more; released once', () => {
  const rooms = Array.from({ length: 6 }, (_, i) => photos.admit(`10.9.0.${i}`, 100_000)!);
  assert.equal(photos.inHand().bytes, 600_000);
  const chunked = photos.admit('10.9.1.1', null)!, huge = photos.admit('10.9.1.2', 5 * photos.MAX_BYTES)!;
  assert.deepEqual([chunked.bytes, huge.bytes], [photos.MAX_BYTES, photos.MAX_BYTES]);
  for (const r of [...rooms, chunked, huge]) { r.release(); r.release(); } // twice is once
  assert.deepEqual(photos.inHand(), { bytes: 0, uploads: 0 });
});

test('attached to its case, each photo goes to HQ once HQ has the card, named <order>-<n>-<shot>.jpg; then care deletes its file', async () => {
  const { conv } = await customer();
  const ids: string[] = [];
  for (const shot of ['box', 'label', 'product']) { const r = await photos.accept({ ...base(conv), shot, bytes: JPEG }); assert.ok(r.ok); ids.push(r.id); }
  const caseId = Number(db.prepare("insert into cases (app, conversation, kind, checked, created) values ('shop', ?, 'claim', 'order', ?)").run(conv, now()).lastInsertRowid);
  assert.equal(photos.attach(conv, 'shop', CLAIM.order, 'damaged', caseId), 3);
  got.length = 0;
  await photos.push();
  assert.equal(got.length, 0, 'not before HQ has the case');
  db.prepare('update cases set sent_hq = ? where id = ?').run(now(), caseId);
  hqDown = true;
  await photos.push();
  assert.ok(ids.every(id => existsSync(file(id))), 'kept while HQ refuses');
  hqDown = false;
  await photos.push();
  assert.deepEqual(got.map(g => [g.url.searchParams.get('case'), g.url.searchParams.get('name'), g.type, g.auth]), [
    [`H-${1000 + caseId}`, 'ORD-7Q4K-M2-1-box.jpg', 'image/jpeg', 'Bearer hq-test-token'],
    [`H-${1000 + caseId}`, 'ORD-7Q4K-M2-2-label.jpg', 'image/jpeg', 'Bearer hq-test-token'],
    [`H-${1000 + caseId}`, 'ORD-7Q4K-M2-3-product.jpg', 'image/jpeg', 'Bearer hq-test-token']]);
  assert.ok(got.every(g => g.bytes[0] === 0xff && g.bytes[1] === 0xd8));
  assert.ok(ids.every(id => !existsSync(file(id))), 'files gone once HQ has them');
  assert.ok(rows(conv).every(r => r.sent_hq), 'rows kept for the counts');
  got.length = 0;
  await photos.push();
  assert.equal(got.length, 0, 'sent once');
});

test('the sweep: a photo never attached goes after 7 days, a file without a live row now; attached ones wait for HQ', async () => {
  const { conv } = await customer();
  const a = await photos.accept({ ...base(conv), shot: 'box', bytes: JPEG }), b = await photos.accept({ ...base(conv), shot: 'label', bytes: JPEG });
  assert.ok(a.ok && b.ok);
  const caseId = Number(db.prepare("insert into cases (app, conversation, kind, checked, created) values ('shop', ?, 'claim', 'order', ?)").run(conv, now()).lastInsertRowid);
  db.prepare('update photos set claim = ? where id = ?').run(caseId, b.id);
  writeFileSync(join(DATA, 'photos', 'orphan.jpg'), JPEG);
  photos.sweep(now() + 6 * 864e5);
  assert.ok(existsSync(file(a.id)) && existsSync(file(b.id)));
  assert.ok(!existsSync(join(DATA, 'photos', 'orphan.jpg')));
  photos.sweep(now() + 8 * 864e5);
  assert.ok(!existsSync(file(a.id)) && existsSync(file(b.id)), 'the unattached one went, the attached one waits for HQ');
  assert.deepEqual(rows(conv).map(r => r.id), [b.id]);
  // a deleted conversation takes its rows with it (ON DELETE CASCADE): its files go at the next sweep
  db.prepare('delete from conversations where id = ?').run(conv);
  photos.sweep();
  assert.ok(!existsSync(file(b.id)));
});

test('the widget spec: every word from the server, in the conversation\'s language', () => {
  const en = photos.slotsFor('shop', ['label', 'product'], 'en');
  assert.deepEqual(en.slots.map(s => s.label), [t('shot_label', 'en'), t('shot_product', 'en', { thing: 'mug' })]);
  assert.match(en.note, /faces/);
  assert.deepEqual(Object.keys(en.words).sort(), ['again', 'failed', 'got', 'sending', 'take']);
  // a language the company doesn't speak gets its first one's words (the plug-in's own languages: products/care/src/photos.test.ts)
  const de = photos.slotsFor('shop@preview', ['box', 'box_damage', 'closeup', 'contents'], 'de');
  assert.deepEqual(de.slots.map(s => s.label), ['box', 'box_damage', 'closeup', 'contents'].map(x => t(`shot_${x}`, 'en')));
  assert.ok(photos.slotsFor('shop', ['box'], 'nl').slots[0].hint.length > 0);
});

test.after(() => { shop.close(); hqServer.close(); setTimeout(() => process.exit(0), 50); });
