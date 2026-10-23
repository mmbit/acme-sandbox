// node --test src/photos.test.ts   (the desk phone's photo fields: the test company, HQ's real server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { request } from 'node:http';
import { harness } from './harness.ts';

const h = await harness('photos');
const DATA = h.dataDir;
const photos = await import('./photos.ts');   // (stripJpeg, stripPng: pictures.ts's too; parseFields: documents.ts's)
const { ORIGIN } = await import('./config.ts');
const dex = await h.start({ agent: 'dex' });

// ---------------------------------------------------------------- fixtures (ImageMagick output, inlined)
// convert -size 48x32 gradient:red-blue -strip -quality 60 base.jpg (a baseline JPEG: SOI APP0 DQT DQT SOF0 DHT×4 SOS EOI)
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAgADADASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAQDBv/EABUQAQEAAAAAAAAAAAAAAAAAAAAS/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYB/8QAFhEBAQEAAAAAAAAAAAAAAAAAABRh/9oADAMBAAIRAxEAPwDnLLT2WyHFpYostPZZDhYostPZZDhYwstPZayhxKWKLLT2WQ4WKLLT2WQ4WP/Z', 'base64');
// convert -size 16x16 gradient:green-yellow -strip -interlace JPEG prog.jpg (progressive: SOF2 and 10 scans with DHTs between)
const PROG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wgARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAABAb/xAAUAQEAAAAAAAAAAAAAAAAAAAAC/9oADAMBAAIQAxAAAAEppyjC/8QAGRABAAMBAQAAAAAAAAAAAAAAAgEDBAAT/9oACAEBAAEFArdAfK2QnMiMx96P/8QAGREAAgMBAAAAAAAAAAAAAAAAAQMAAhJB/9oACAEDAQE/AX3wQWcn/8QAFhEAAwAAAAAAAAAAAAAAAAAAAAQh/9oACAECAQE/AV4f/8QAGhAAAgIDAAAAAAAAAAAAAAAAAAECESFBYv/aAAgBAQAGPwK2XHKZyVs//8QAGxAAAgMAAwAAAAAAAAAAAAAAAAERITFBcYH/2gAIAQEAAT8hUrZ0SowSi+tvtgq/75P/2gAMAwEAAgADAAAAEKP/xAAYEQEAAwEAAAAAAAAAAAAAAAABACEx8P/aAAgBAwEBPxCvArTsn//EABoRAAICAwAAAAAAAAAAAAAAAAExABEhYfD/2gAIAQIBAT8QwG1vmJ//xAAdEAEAAgICAwAAAAAAAAAAAAABETEAIUGBYeHw/9oACAEBAAE/EIByQE0lTfzmsf0dVxj1dhIw9+POTCAAwJ6vRn//2Q==', 'base64');
// convert -size 4x4 gradient:red-blue -strip png24:base.png (IHDR IDAT IEND)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAF0lEQVQI12P8z4AALKsZQrFzGBkYEAoBe+gECZtuXNMAAAAASUVORK5CYII=', 'base64');

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const seg = (m: number, payload: string | Buffer) => { const p = Buffer.from(payload as any, 'latin1'); return Buffer.concat([Buffer.from([0xff, m]), u16(p.length + 2), p]); };
const SOI = Buffer.from([0xff, 0xd8]);
const EXIF = seg(0xe1, 'Exif\0\0MM\0*\0\0\0\x08GPSLatitude 52.3676 N GPSLongitude 4.9041 E iPhone 15 Pro');
const XMP = seg(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><exif:GPSLatitude>52,22.05N</exif:GPSLatitude></x:xmpmeta>');
const COM = seg(0xfe, 'shot at home, Keizersgracht');
const MPF = seg(0xe2, 'MPF\0II*\0 two more images follow');
const ICC = seg(0xe2, 'ICC_PROFILE\0\x01\x01 a pretend profile');
const OTHER = seg(0xed, 'Photoshop 3.0\0 8BIM location');
// What a phone makes: Exif first, an MPF index, XMP, a comment (after a fill byte), and, after the primary image's EOI,
// a second image (a gain map) with its own Exif.
const phone = (img = JPEG) => Buffer.concat([SOI, EXIF, MPF, ICC, XMP, OTHER, Buffer.from([0xff]), COM, img.subarray(2), SOI, EXIF, JPEG.subarray(2)]);
const has = (b: Buffer, s: string) => b.includes(Buffer.from(s, 'latin1'));

const chunk = (type: string, data: string | Buffer) => {
  const d = Buffer.from(data as any, 'latin1'), len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type, 'latin1'), d]);
  len.writeUInt32BE(d.length); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const IHDR_END = 8 + 25, IEND_AT = PNG.length - 12;

// ---------------------------------------------------------------- stripping
test('JPEG: Exif, XMP, MPF, other APPn and comments go; what decoding needs stays, byte for byte; nothing after EOI', () => {
  const out = photos.stripJpeg(phone())!;
  assert.ok(out);
  assert.deepEqual(out, Buffer.concat([SOI, ICC, JPEG.subarray(2)])); // exactly the original plus its ICC profile
  for (const s of ['GPS', 'Exif', 'xmpmeta', 'Keizersgracht', 'MPF', 'Photoshop', 'iPhone']) assert.ok(!has(out, s), s);
  assert.deepEqual([...out.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...out.subarray(-2)], [0xff, 0xd9]);
  assert.equal(out.indexOf(Buffer.from([0xff, 0xd8]), 2), -1); // the appended image is gone
  // a clean file comes through unchanged
  assert.deepEqual(photos.stripJpeg(JPEG), JPEG);
});

test('JPEG: a progressive file keeps every scan', () => {
  const scans = (b: Buffer) => { let n = 0; for (let i = 0; i < b.length - 1; i++) if (b[i] === 0xff && b[i + 1] === 0xda) n++; return n; };
  assert.ok(scans(PROG) > 2);
  const out = photos.stripJpeg(phone(PROG))!;
  assert.deepEqual(out, Buffer.concat([SOI, ICC, PROG.subarray(2)]));
  assert.equal(scans(out), scans(PROG));
});

test('JPEG: stuffed bytes, restart markers and fill bytes stay in the scan; other markers end it', () => {
  const head = Buffer.concat([SOI, seg(0xe0, 'JFIF\0\x01\x01\0\0\x01\0\x01\0\0'), seg(0xdd, '\0\x01'), seg(0xc0, '\x08\0\x01\0\x01\x01\x01\x11\0'), seg(0xda, '\x01\x01\0\0\x3f\0')]);
  const scan = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd7, 0x78, 0xff, 0xff]);
  const img = Buffer.concat([head, scan, Buffer.from([0xff, 0xd9])]);
  assert.deepEqual(photos.stripJpeg(Buffer.concat([img, Buffer.from('trailing junk')])), img);
  // a comment in the middle of the scans (after the first scan ends) is dropped too
  const withCom = Buffer.concat([head, scan, COM, Buffer.from([0xff, 0xd9])]);
  assert.deepEqual(photos.stripJpeg(withCom), img);
});

test('JPEG: what does not parse is refused', () => {
  for (const b of [Buffer.from('hello'), PNG, JPEG.subarray(0, 200), Buffer.concat([JPEG.subarray(0, -2)]),
    Buffer.concat([SOI, seg(0xe0, 'JFIF\0'), Buffer.from([0xff, 0xd9])]),             // no image at all
    Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0xff, 0xff]), EXIF]),                // a segment longer than the file
    Buffer.concat([SOI, Buffer.from([0x00]), JPEG.subarray(2)]),                      // garbage between segments
    Buffer.concat([SOI, Buffer.from([0xff, 0xd8]), JPEG.subarray(2)])])               // a second SOI in the header
    assert.equal(photos.stripJpeg(b), null);
});

test('PNG: eXIf, text and time go; the rest is byte-identical; nothing after IEND', () => {
  const dirty = Buffer.concat([PNG.subarray(0, IHDR_END), chunk('eXIf', 'MM\0*GPSLatitude 52.3676'), chunk('tEXt', 'Comment\0shot at home'),
    chunk('iTXt', 'XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>'), chunk('pHYs', '\0\0\x0b\x13\0\0\x0b\x13\x01'), PNG.subarray(IHDR_END, IEND_AT),
    chunk('tIME', '\x07\xea\x09\x1b\x0c\0\0'), chunk('zzZz', 'unknown'), PNG.subarray(IEND_AT), Buffer.from('after the end GPS')]);
  const out = photos.stripPng(dirty)!;
  assert.deepEqual(out, Buffer.concat([PNG.subarray(0, IHDR_END), chunk('pHYs', '\0\0\x0b\x13\0\0\x0b\x13\x01'), PNG.subarray(IHDR_END)]));
  for (const s of ['eXIf', 'tEXt', 'iTXt', 'tIME', 'GPS', 'zzZz']) assert.ok(!has(out, s), s);
  assert.deepEqual(photos.stripPng(PNG), PNG);
  for (const b of [JPEG, PNG.subarray(0, 30), Buffer.concat([PNG.subarray(0, 8), PNG.subarray(IHDR_END)]), Buffer.concat([PNG.subarray(0, IHDR_END), PNG.subarray(IEND_AT)])])
    assert.equal(photos.stripPng(b), null);
});

// ---------------------------------------------------------------- fields
const card = (extra: Record<string, unknown> = {}, job = dex) => h.agent('request', job.token, { kind: 'action', title: 'Photos of the test print', body: 'Hang Ava…',
  urgency: 'today', photos: [{ label: "Ava's top edge with a ruler" }, { label: 'Anything that looks wrong', optional: true }], ...extra });
const ask = async (extra: Record<string, unknown> = {}, job = dex) => { const r = await card(extra, job); assert.equal(r.status, 200); return r.body.id as number; };

test('photo fields: cleaned, capped, unique, and only next to an answer box', async () => {
  assert.deepEqual(photos.parseFields([' Ava\u200b’s\n top  edge\u202e ', { label: 'X', optional: true }, { label: 'Y', optional: 'yes' }]),
    [{ label: 'Ava’s top edge' }, { label: 'X', optional: true }, { label: 'Y' }]);
  assert.equal(photos.parseFields(undefined), undefined);
  assert.equal(photos.parseFields([]), undefined);
  for (const bad of ['a', [''], ['\u200b \u2066'], ['x'.repeat(81)], ['A', 'a'], Array.from({ length: 9 }, (_, i) => `P${i}`), [{ label: 3 }], [null]])
    assert.equal(photos.parseFields(bad), null, JSON.stringify(bad));
  assert.ok(photos.parseFields(['é'.repeat(80)]));
  // a product shot is a photo field like the others, kept as one only when it says exactly so
  assert.deepEqual(photos.parseFields([{ label: 'Front, flat on white', shot: 'product' }, { label: 'Back', optional: true, shot: 'product' },
    { label: 'With a ruler', shot: 'other' }, { label: 'Edge', shot: 'Product' }, 'Corner']),
  [{ label: 'Front, flat on white', shot: 'product' }, { label: 'Back', optional: true, shot: 'product' }, { label: 'With a ruler' }, { label: 'Edge' }, { label: 'Corner' }]);
  assert.equal(photos.parseFields([...Array.from({ length: 8 }, (_, i) => `P${i}`), { label: 'Shop', shot: 'product' }]), null, 'counted with the others');
  assert.equal(photos.parseFields([{ label: 'Front', shot: 'product' }, 'front']), null, 'labels differ across both kinds');
  for (const extra of [{ photos: ['A', 'A'] }, { kind: 'credential', secrets: 'SOME_TEST_KEY' }, { kind: 'approval', approves: 'live:pebblet' }, { kind: 'login', seat: 'server-9' }])
    assert.equal((await card(extra)).status, 400, JSON.stringify(extra));
  assert.equal((await card({ secrets: '' })).status, 200, 'an empty secrets string (hq ask without keys) is no key request');
});

// ---------------------------------------------------------------- upload, answer, fetch
// the board adds a photo on the desk phone
const put = (id: number, field: string | number, body: Buffer | null, { type = 'image/jpeg', length = undefined as number | undefined, chunked = false } = {}) =>
  new Promise<{ status: number; json: any }>((resolve, reject) => {
    const q = request(`${h.base}/api/requests/photo?id=${id}&field=${field}`, { method: 'POST',
      headers: { cookie: h.boardCookie, origin: ORIGIN, 'content-type': type, ...(length !== undefined ? { 'content-length': length } : chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': body?.length ?? 0 }) } }, res => {
      let t = ''; res.setEncoding('utf8'); res.on('data', c => t += c);
      res.on('end', () => resolve({ status: res.statusCode!, json: t ? JSON.parse(t) : null }));
    });
    q.on('error', e => ['EPIPE', 'ECONNRESET'].includes((e as any).code) ? resolve({ status: 413, json: null }) : reject(e)); // cut off mid-upload
    if (chunked && body) { let i = 0; const next = () => { if (i >= body.length) return q.end(); q.write(body.subarray(i, i += 256 * 1024), next); }; next(); }
    else if (length !== undefined) q.write(Buffer.alloc(1024)); // says 9 MB, sends a little: the answer comes first
    else q.end(body ?? undefined);
  });

test('the board uploads: stripped, stored 0600 in a 0700 dir, replaceable; bad requests refused', async () => {
  const id = await ask(), dir = `${DATA}/photos/${id}`;
  assert.equal((await put(id, 0, phone())).status, 200);
  const saved = readFileSync(`${dir}/0.jpg`);
  assert.deepEqual(saved, Buffer.concat([SOI, ICC, JPEG.subarray(2)]));
  assert.ok(!has(saved, 'GPS'));
  assert.equal(statSync(`${dir}/0.jpg`).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(`${DATA}/photos`).mode & 0o777, 0o700);
  // replaced by a PNG: the JPEG goes
  assert.equal((await put(id, 0, PNG, { type: 'image/png' })).status, 200);
  assert.ok(existsSync(`${dir}/0.png`) && !existsSync(`${dir}/0.jpg`));
  // refusals
  assert.equal((await put(id, 2, JPEG)).status, 400);            // no such field
  assert.equal((await put(id, '-1', JPEG)).status, 400);
  assert.equal((await put(id, 'x', JPEG)).status, 400);
  assert.equal((await put(99999, 0, JPEG)).status, 404);         // no such request
  const plain = await h.ask(dex, { title: 'No photos here', body: '.' });
  assert.equal((await put(plain, 0, JPEG)).status, 404);      // a request without photo fields
  assert.equal((await put(id, 1, Buffer.from('<svg/>'), { type: 'image/svg+xml' })).status, 415);
  assert.equal((await put(id, 1, Buffer.from('not a picture at all'))).status, 400); // non-image
  assert.equal((await put(id, 1, JPEG, { type: 'image/png' })).status, 400);         // magic bytes don't match the type
  assert.equal((await put(id, 1, Buffer.concat([Buffer.from('GIF89a'), JPEG]))).status, 400);
  assert.equal((await put(id, 1, null, { length: 9 * 1024 * 1024 })).status, 413);   // says it's too big
  const big = Buffer.concat([JPEG.subarray(0, -2), Buffer.alloc(8 * 1024 * 1024), Buffer.from([0xff, 0xd9])]);
  assert.equal((await put(id, 1, big, { chunked: true })).status, 413);             // turns out too big
  assert.ok(!existsSync(`${dir}/1.jpg`) && !existsSync(`${dir}/1.png`));
});

test('required photos gate the answer; the agent hears how many came; photos stay after; a closed request takes no more', async () => {
  const job = await h.start({ agent: 'dex', title: 'Test print photos' }), id = await ask({}, job);
  const listed = async () => ((await h.board('/api/requests')).body as any[]).find(r => r.id === id);
  assert.deepEqual((await listed()).photos, [{ label: "Ava's top edge with a ruler", optional: false, saved: false }, { label: 'Anything that looks wrong', optional: true, saved: false }]);
  assert.equal((await h.answer(id, 'Rails cover 4 mm.')).status, 400, 'the required one is missing');
  assert.equal((await put(id, 0, phone())).status, 200);
  assert.deepEqual((await listed()).photos.map((p: any) => p.saved), [true, false]);
  assert.equal((await h.answer(id, 'Rails cover 4 mm.')).status, 200);
  assert.equal((await h.agent('request-answer', job.token, { id })).body.answer, `Rails cover 4 mm.\n\nPhotos: 1 of 2 saved. Fetch them with \`hq photos ${id}\`.`);
  assert.equal((await put(id, 1, JPEG)).status, 409);
  // the asking agent's side (only Dex: hq photos), what its job reads
  const see = (path: string, by = job) => h.agent(path, by.token);
  assert.notEqual((await see(`photos?id=${id}`, await h.start({ agent: 'wren' }))).status, 200);
  const list = (await see(`photos?id=${id}`)).body as any[];
  assert.deepEqual(list.map(({ bytes, ...p }) => p), [{ field: 0, label: "Ava's top edge with a ruler", optional: false, saved: true, type: 'image/jpeg' },
    { field: 1, label: 'Anything that looks wrong', optional: true, saved: false, type: null }]);
  assert.equal(list[0].bytes, ICC.length + JPEG.length);
  const one = (await see(`photo?id=${id}&field=0`)).body;
  assert.equal(one.type, 'image/jpeg');
  assert.deepEqual(Buffer.from(one.data, 'base64'), Buffer.concat([SOI, ICC, JPEG.subarray(2)]));
  for (const path of [`photo?id=${id}&field=1`, `photo?id=${id}&field=x`, 'photos?id=99999']) assert.equal((await see(path)).status, 404, path);
});

test('a product shot says so on the desk phone and to the asking agent; a check photo stays a plain field', async () => {
  const job = await h.start({ agent: 'dex', title: 'Shop photos' });
  const id = await ask({ photos: [{ label: 'The mug, handle left, on white', shot: 'product' }, { label: 'The print with a ruler' }] }, job);
  const listed = ((await h.board('/api/requests')).body as any[]).find(r => r.id === id);
  assert.deepEqual(listed.photos, [{ label: 'The mug, handle left, on white', optional: false, shot: 'product', saved: false },
    { label: 'The print with a ruler', optional: false, saved: false }]);
  const list = (await h.agent(`photos?id=${id}`, job.token)).body as any[];
  assert.deepEqual(list.map(p => p.shot), ['product', undefined]);
});

test('a parked job whose request is refused goes back to work with a note, not to a request that never came', async () => {
  const job = await h.start({ agent: 'dex', title: 'Ask for photos' });
  const r = await h.finish(job, { status: 'parked', request: { kind: 'action', title: 'Photos', body: '.', photos: ['same', 'Same'] } });
  assert.equal(r.status, 200);
  assert.deepEqual([h.job(job.id).status, h.job(job.id).request], ['queued', null]);
});
