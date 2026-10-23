// A claim's photos. The widget re-encodes in
// the browser, but that's only for speed: a script skips it. So the server takes nothing but a JPEG's first bytes on
// trust: magic bytes, size and the frame header's width × height are checked here, in JavaScript, before anything decodes;
// then the photo is decoded with limits and written as a fresh JPEG with no metadata (no EXIF, no GPS, no ICC, no
// comments; turned upright first) under a random id in DATA_DIR/photos, outside any web root. No original is kept, the
// model never gets one, and care serves none: each goes to HQ (push), then its file goes.
//
// The decoder is ImageMagick, in a child process. Node has no JPEG decoder; a JavaScript one would
// be a dependency, and a 40-megapixel decode inside the service (a 256 MiB container) would block every chat while it ran,
// and could take the service down with it. A crash or a kill in `magick` takes down only `magick`. It runs one at a time,
// with our own policy.xml (every coder and delegate refused but JPEG; memory, area, size, disk and time bounded), always
// with an explicit `jpeg:-` input so it never guesses a format, a `jpeg:size` hint so libjpeg scales a big photo down in
// the DCT instead of decoding every pixel, a timeout and a kill. In the image only `imagemagick` and `imagemagick-jpeg` are
// installed (Alpine splits most coders out; the few left in its core, like PNG, the policy refuses). Locally and in the
// tests it's the `magick` or `convert` on the PATH, with MAGICK_CONFIGURE_PATH pointing at the same policy (both read it).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statfsSync, unlinkSync, writeFileSync, writeFile } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { db, now, token, limit } from './db.ts';
import { jpegSize } from '../../../shared/pictures/size.ts';
import { DATA_DIR, HQ_URL, HQ_TOKEN } from './config.ts';
import { nameOf, thingOf } from './company.ts';
import { t, type Lang } from './texts.ts';

export const MAX_BYTES = 3 * 1024 * 1024;   // an upload, as sent (the widget's own re-encode stays well under)
const MAX_PIXELS = 40_000_000;              // the frame header's width × height: a decompression bomb stops here
const MAX_SIDE = 16_000;                    // and either side (the policy's 16KP: ImageMagick 7 counts K as 1000)
const OUT_SIDE = 2560;                      // the fresh JPEG's long side at most
const PER_CASE = 6;                         // photos a case (conversation, order, kind), re-takes included
const PER_DAY = 20;                         // tries a conversation a day, failed ones included: each one runs the decoder
const PER_APP_DAY = 400, PER_IP_DAY = 60;   // the same, per app and per address
const FREE_MIN = 200 * 1024 * 1024;         // the volume keeps this much free; past it photos wait (the database matters more)
const KEEP_MS = 7 * 864e5;                  // a photo never attached to a case
const DECODE_MS = 20_000, QUEUE_MAX = 3;
const DAY_MS = 864e5;

export const DIR = join(DATA_DIR, 'photos');
const POLICY = new URL('../magick', import.meta.url).pathname;
const fileOf = (id: string) => join(DIR, `${id}.jpg`);
// a shot is a slot a company's claim asks for (in its plug-in); its label and hint are texts, shot_<shot> and shot_<shot>_hint
export type Shot = string;

// what a claim needs (a company's own tool sets it in conv.state.claim): the order, the case, the shots it asks for
// app: the order's own (one of the session's shop)
export type Claim = { order: string; kind: string; shots: Shot[]; app?: string };
export type Why = 'shot' | 'type' | 'size' | 'pixels' | 'case' | 'day' | 'busy' | 'decode';
export type Result = { ok: true; id: string; shot: Shot } | { ok: false; status: number; why: Why };
const no = (status: number, why: Why): Result => ({ ok: false, status, why });

// ---- the checks before decoding (pure: nothing here looks past the headers)
export const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
// ...that ends where a JPEG ends (FF D9, perhaps zero padding after it). A file that goes on past its end (a script, a ZIP:
// a polyglot) is refused outright: no camera or browser makes one, and the re-encode would drop it anyway.
export function ends(b: Buffer) {
  let i = b.length - 1;
  while (i > 1 && b[i] === 0) i--;
  return i > 2 && b[i - 1] === 0xff && b[i] === 0xd9;
}

// The APPn and COM segments a JPEG carries before its scan (APP1 is EXIF or XMP, APP2 ICC, APP13 Photoshop's IPTC)
export function segments(b: Buffer): number[] {
  const out: number[] = [];
  for (let i = 2; i + 4 <= b.length && b[i] === 0xff;) {
    const m = b[i + 1];
    if (m === 0xda || m === 0xd9) break;
    if ((m >= 0xe0 && m <= 0xef) || m === 0xfe) out.push(m);
    i += 2 + b.readUInt16BE(i + 2);
  }
  return out;
}

// ---- the decoder
// `magick` (ImageMagick 7, the image's) or `convert` (6, a developer's machine): CARE_MAGICK names another
const BIN = process.env.CARE_MAGICK || ['magick', 'convert'].find(n => String(process.env.PATH ?? '').split(delimiter).some(d => d && existsSync(join(d, n)))) || 'magick';

// A photo longer than 2560 px is decoded smaller, in libjpeg's DCT: ImageMagick turns jpeg:size into a scale 1/d (d the
// whole part of the ratio), and libjpeg-turbo decodes at the smallest M/8 at least that. The smallest d whose decode is
// at most 2560 px long, so nothing bigger than a 2560 × 2560 image is ever held (about 110 MB in ImageMagick 7's float
// pixels) and no resize is needed after it (a resize's buffers nearly doubled that: a 6000 × 4000 photo cost 190 MB).
const scaled = (side: number, d: number) => Math.ceil(side * Math.ceil(8 / d) / 8);
export function hint(width: number, height: number) {
  if (Math.max(width, height) <= OUT_SIDE) return null;
  let d = 2;
  while (d < 8 && scaled(Math.max(width, height), d) > OUT_SIDE) d++;
  return `${Math.floor(width / d)}x${Math.floor(height / d)}`;
}

export type Decoder = (bytes: Buffer, size: { width: number; height: number }) => Promise<Buffer>;
// One decode: the upload on stdin, the fresh JPEG on stdout. The child gets no secrets (only PATH and its own settings),
// one thread, and the most likely place in an out-of-memory kill (oom_score_adj 1000), so it goes, not the service.
export const reencode: Decoder = (bytes, size) => new Promise((resolve, reject) => {
  const scale = hint(size.width, size.height);
  const args = [...(scale ? ['-define', `jpeg:size=${scale}`] : []), 'jpeg:-', '-auto-orient', '-resize', `${OUT_SIDE}x${OUT_SIDE}>`,
    '-colorspace', 'sRGB', '-strip', '-sampling-factor', '4:2:0', '-quality', '85', 'jpeg:-'];
  const child = spawn(BIN, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', MAGICK_CONFIGURE_PATH: POLICY,
    MAGICK_TEMPORARY_PATH: tmpdir(), MAGICK_THREAD_LIMIT: '1', OMP_NUM_THREADS: '1' } });
  if (child.pid) writeFile(`/proc/${child.pid}/oom_score_adj`, '1000', () => { /* not Linux, or already gone: the limits still hold */ });
  const out: Buffer[] = []; let size_ = 0, done = false;
  const end = (err: Error | null, b?: Buffer) => { if (done) return; done = true; clearTimeout(timer); err ? reject(err) : resolve(b!); };
  const timer = setTimeout(() => { child.kill('SIGKILL'); end(new Error('decode timed out')); }, DECODE_MS);
  child.stdout.on('data', (c: Buffer) => { size_ += c.length; if (size_ > MAX_BYTES * 2) { child.kill('SIGKILL'); end(new Error('decode output too big')); } else out.push(c); });
  child.stderr.resume(); // its messages name temp files, never what's in the photo; they're not kept
  child.on('error', err => end(err));
  child.on('close', code => code === 0 ? end(null, Buffer.concat(out)) : end(new Error(`decoder exited ${code}`)));
  child.stdin.on('error', () => { /* it stopped reading: its exit code says why */ });
  child.stdin.end(bytes);
});

// one decode at a time: two at once could pass the container's memory between them
let queue: Promise<unknown> = Promise.resolve(), waiting = 0;
function queued<T>(f: () => Promise<T>): Promise<T> {
  waiting++;
  const p = queue.then(f, f);
  queue = p.catch(() => {}).finally(() => waiting--);
  return p;
}

// ---- room for an upload, taken before its body is read
// Every photo in hand counts against one budget, from its first byte to the end of its decode: a body being read,
// waiting for the decoder or decoding holds what it declared (Content-Length; 3 MB when it sends none). The checks in
// accept() only see a body once it's all in, so without this, slow bodies that never finish would each hold 3 MB in
// the service's memory, as many as anyone cared to open. Past the budget, or past 2 at once from one address, the next
// is refused before a byte of it is read. The server frees the room once the photo is done, whatever happened to it,
// and drops a body still coming after UPLOAD_MS (config.ts).
const BUDGET = 4 * MAX_BYTES, PER_ADDRESS = 2;
let held = 0;
const holding = new Map<string, number>();
export type Room = { bytes: number; release: () => void };
export function admit(ip: string, declared: number | null): Room | null {
  const bytes = declared != null && declared >= 0 ? Math.min(declared, MAX_BYTES) : MAX_BYTES, n = holding.get(ip) ?? 0;
  if (held + bytes > BUDGET || n >= PER_ADDRESS) return null;
  held += bytes; holding.set(ip, n + 1);
  let done = false;
  return { bytes, release: () => {
    if (done) return;
    done = true; held -= bytes;
    const left = holding.get(ip)! - 1;
    left ? holding.set(ip, left) : holding.delete(ip);
  } };
}
export const inHand = () => ({ bytes: held, uploads: [...holding.values()].reduce((a, b) => a + b, 0) }); // for the tests

// ---- an upload
// Checked in this order: the shot is one the claim asks for; the bytes are a JPEG of at most 3 MB and 40 MP by their
// headers; the case's 6 and the day's 20 aren't reached (counted before decoding, so a failed decode counts too); then
// decoded. The order and the case come from the conversation's claim, never from the request (server.ts).
export async function accept(a: { app: string; conversation: number; claim: Claim; shot: string; bytes: Buffer; ip: string }, decode: Decoder = reencode): Promise<Result> {
  const { claim, bytes } = a;
  // a plain word the claim asks for (it names the photo's file at HQ): the claim's shots are the server's own (above)
  const shot = /^[a-z_]{1,20}$/.test(a.shot) ? a.shot : undefined;
  if (!shot || !claim.shots.includes(shot)) return no(400, 'shot');
  if (!isJpeg(bytes) || !ends(bytes)) return no(415, 'type');
  if (bytes.length > MAX_BYTES) return no(413, 'size');
  const size = jpegSize(bytes);
  if (!size || !size.width || !size.height || size.width > MAX_SIDE || size.height > MAX_SIDE || size.width * size.height > MAX_PIXELS) return no(413, 'pixels');
  // a claim is an order's in its own app: another app of the shop can have an order with the same id
  const n = (db.prepare('select count(*) as n from photos where conversation = ? and app = ? and order_id = ? and kind = ?').get(a.conversation, a.app, claim.order, claim.kind) as any).n;
  if (n >= PER_CASE) return no(429, 'case');
  if (waiting >= QUEUE_MAX || !room()) return no(503, 'busy');
  if (!limit(`photo:${a.conversation}`, PER_DAY, DAY_MS) || !limit(`photo-ip:${a.ip}`, PER_IP_DAY, DAY_MS) || !limit(`photo-app:${a.app}`, PER_APP_DAY, DAY_MS)) return no(429, 'day');
  // the row first (bytes 0: being decoded), so a second upload while this one decodes counts it
  const id = token();
  db.prepare('insert into photos (id, conversation, app, order_id, kind, shot, bytes, created) values (?, ?, ?, ?, ?, ?, 0, ?)')
    .run(id, a.conversation, a.app, claim.order, claim.kind, shot, now());
  let out: Buffer;
  try {
    out = await queued(() => decode(bytes, size));
    const o = jpegSize(out);
    // a check on what came out, not on the decoder's word: a JPEG, within the size, and no metadata segment but JFIF's
    if (!isJpeg(out) || !o || Math.max(o.width, o.height) > OUT_SIDE || segments(out).some(m => m !== 0xe0)) throw new Error('decoder output refused');
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    writeFileSync(fileOf(id), out, { mode: 0o600, flag: 'wx' });
    db.prepare('update photos set bytes = ?, width = ?, height = ? where id = ?').run(out.length, o.width, o.height, id);
  } catch (err: any) {
    db.prepare('delete from photos where id = ?').run(id);
    console.error(`care: conversation ${a.conversation}: a photo didn't decode (${err?.message})`);
    return no(422, 'decode');
  }
  // the same shot again (a re-take) takes the earlier one's place: its file goes, its row stays for the count
  const old = db.prepare('select id from photos where conversation = ? and app = ? and order_id = ? and kind = ? and shot = ? and id != ? and bytes > 0 and replaced is null and claim is null')
    .all(a.conversation, a.app, claim.order, claim.kind, shot, id) as any[];
  for (const r of old) { gone(r.id); db.prepare('update photos set replaced = ? where id = ?').run(now(), r.id); }
  return { ok: true, id, shot };
}

function room() {
  try { const s = statfsSync(DATA_DIR); return s.bavail * s.bsize > FREE_MIN; } catch { return true; } // no statfs: the policy's limits still bound one photo
}
const gone = (id: string) => { try { unlinkSync(fileOf(id)); } catch { /* already gone */ } };

// ---- what a company's claim tools read
// the shots filled for a case: an order of an app (the app, as above)
export const filled = (conversation: number, app: string, order: string, kind: string, free = false): Shot[] =>
  (db.prepare(`select distinct shot from photos where conversation = ? and app = ? and order_id = ? and kind = ? and bytes > 0 and replaced is null${free ? ' and claim is null' : ''} order by shot`)
    .all(conversation, app, order, kind) as any[]).map(r => r.shot);

// The widget's spec for the shots asked for: one slot each with its label and hint, the note shown before the camera
// opens, and the widget's own words. All text from here (texts.ts), so the widget draws nothing of its own.
export function slotsFor(app: string, shots: Shot[], lang: Lang) {
  const vars = { thing: thingOf(app), app: nameOf(app) };
  return {
    slots: shots.map(shot => ({ shot, label: t(`shot_${shot}`, lang, vars), hint: t(`shot_${shot}_hint`, lang, vars) })),
    note: t('photos_note', lang),
    words: { take: t('photo_take', lang), again: t('photo_again', lang), sending: t('photo_sending', lang), got: t('photo_got', lang), failed: t('photo_bad', lang) },
  };
}
// the label a shot has in the chat ("📷 The shipping label": the customer's message for an upload)
export const label = (app: string, shot: Shot, lang: Lang) => slotsFor(app, [shot], lang).slots[0].label;

// The claim is filed (cases row `caseId`): its photos go with it. Returns how many.
export const attach = (conversation: number, app: string, order: string, kind: string, caseId: number) => Number(db.prepare(
  'update photos set claim = ? where conversation = ? and app = ? and order_id = ? and kind = ? and bytes > 0 and replaced is null and claim is null')
  .run(caseId, conversation, app, order, kind).changes);

// ---- to HQ, the only place a photo is ever served (behind the board's login, as image/jpeg with nosniff)
// POST {HQ_URL}/api/care/photos?case=H-1042&name=<order>-<n>-<shot>.jpg, the JPEG as the body. Only once HQ has the case's
// card (hq.ts sends cases first), so the photo always has a card to land on. HQ has it: its file goes, the row stays.
const safeName = (s: string) => s.replace(/[^A-Za-z0-9-]/g, '_').slice(0, 40);
export async function push() {
  if (!HQ_URL || !HQ_TOKEN) return;
  // numbered within the case in the order they were taken, sent ones included, so a name never changes between runs
  const rows = db.prepare(`select * from (select p.id, p.claim, p.order_id, p.shot, p.sent_hq, row_number() over (partition by p.claim order by p.created, p.id) as n
    from photos p join cases c on c.id = p.claim where p.bytes > 0 and p.replaced is null and c.sent_hq is not null) where sent_hq is null limit 50`).all() as any[];
  for (const r of rows) {
    const ref = `H-${1000 + r.claim}`, name = `${safeName(r.order_id)}-${r.n}-${r.shot}.jpg`;
    let body: Buffer;
    try { body = readFileSync(fileOf(r.id)); } catch {
      console.error(`care: photo ${r.id} of case ${ref} has no file: not sent`);
      db.prepare('update photos set replaced = ? where id = ?').run(now(), r.id); // nothing to send, ever: it stops being asked for
      continue;
    }
    try {
      const res = await fetch(`${HQ_URL}/api/care/photos?case=${encodeURIComponent(ref)}&name=${encodeURIComponent(name)}`, { method: 'POST',
        headers: { authorization: `Bearer ${HQ_TOKEN}`, 'content-type': 'image/jpeg' }, body, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HQ answered ${res.status}`);
      await res.body?.cancel();
      db.prepare('update photos set sent_hq = ? where id = ?').run(now(), r.id);
      gone(r.id);
    } catch (err: any) { console.error(`care: HQ didn't take photo ${r.id} of case ${ref}:`, err?.message); }
  }
}

// ---- retention: a photo never attached to a case goes after 7 days; one HQ has is gone already (push);
// and any file no live row keeps (a deleted or forgotten conversation took its rows with it) goes now. A row is written
// before its file, so a photo being decoded always has one.
export function sweep(t = now()) {
  for (const r of db.prepare('select id from photos where claim is null and created < ?').all(t - KEEP_MS) as any[]) gone(r.id);
  db.prepare('delete from photos where claim is null and created < ?').run(t - KEEP_MS);
  let names: string[];
  try { names = readdirSync(DIR); } catch { return; } // no photo yet
  const keep = db.prepare('select 1 from photos where id = ? and replaced is null and sent_hq is null');
  for (const f of names) if (!(f.endsWith('.jpg') && keep.get(f.slice(0, -4)))) { try { unlinkSync(join(DIR, f)); } catch { /* gone meanwhile */ } }
}
