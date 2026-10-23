// Photo fields on desk-phone requests: an agent asks the board for pictures (hq ask/request --photo "label"), the
// board adds them from its tablet next to the answer box, and the agent fetches them (hq photos <id>).
//   - The request stores only the fields: [{ label, optional?, shot? }]. A photo is "saved" when its file exists.
//   - shot: 'product' marks a product photo, one the shop may show (the photo studio edits it, hq studio add). Every
//     other field is a check photo, only for us to check a print (a ruler welcome), never the studio's.
//   - Files live in the coordinator's data volume, never the repo: photos/<request>/<field>.jpg|png (0700/0600).
//   - Phone photos carry GPS and more. HQ re-encodes before uploading, but the server is what guarantees it: every
//     upload is cut down to the chunks/segments needed to show the picture (stripJpeg, stripPng), or refused.
//   - Photos stay after the answer, for the agent to fetch later. No retention rule yet (open).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db.ts';
import { DATA_DIR } from './config.ts';
import { readBody } from '../../../shared/routes/routes.ts';
import { reply } from './uploads.ts';

export const DIR = `${DATA_DIR}/photos`;
const MAX_BYTES = 8 * 1024 * 1024,
  MAX_FIELDS = 8,
  MAX_LABEL = 80;
mkdirSync(DIR, { recursive: true, mode: 0o700 });

export type Label = { label: string; optional?: true };
export type Field = Label & { shot?: 'product' };

// ---------------------------------------------------------------- the fields
// Labels are shown to the board: plain, one line, nothing a browser wouldn't draw.
const INVISIBLE = /[\p{C}\p{Default_Ignorable_Code_Point}]/gu;
const clean = (s: string) =>
  s
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]/g, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();

// A request's photo fields from what the agent sent: undefined for none, null when they don't make sense.
// (shot)
export function parseFields(v: unknown): Field[] | null | undefined {
  const labels = parseLabels(v);
  if (!labels) return labels;
  return labels.map((f, i) =>
    (v as { shot?: unknown }[])[i]?.shot === 'product' ? { ...f, shot: 'product' as const } : f,
  );
}

// The labels of a request's fields, as for photos (documents.ts and zips.ts build theirs on them): undefined for none,
// null when they don't make sense.
export function parseLabels(v: unknown): Label[] | null | undefined {
  if (v === undefined || v === null || (Array.isArray(v) && !v.length)) return undefined;
  if (!Array.isArray(v) || v.length > MAX_FIELDS) return null;
  const out: Label[] = [],
    seen = new Set<string>();
  for (const f of v) {
    const label =
      typeof f === 'string'
        ? clean(f)
        : f && typeof f === 'object' && typeof f.label === 'string'
          ? clean(f.label)
          : '';
    const n = [...label].length;
    if (!n || n > MAX_LABEL || seen.has(label.toLowerCase())) return null;
    seen.add(label.toLowerCase());
    out.push(f?.optional === true ? { label, optional: true } : { label });
  }
  return out;
}

// A request's fields as stored (documents.ts reads its own through it)
export const fieldsOf = <F = Field>(json: string | null): F[] => {
  try {
    return json ? JSON.parse(json) : [];
  } catch {
    return [];
  }
};
const fileOf = (id: number, i: number) => ['jpg', 'png'].map(e => `${DIR}/${id}/${i}.${e}`).find(p => existsSync(p));

// What the desk phone shows: each field, a product photo's shot, and whether a photo is saved for it.
// (shot)
export const state = (id: number, json: string | null) =>
  fieldsOf(json).map((f, i) => ({
    label: f.label,
    optional: !!f.optional,
    ...(f.shot && { shot: f.shot }),
    saved: !!fileOf(id, i),
  }));

// answerRequest: every required photo must be in. Returns the line the agent's answer ends with, or 400.
export function answerLine(id: number, json: string) {
  const s = state(id, json);
  if (s.some(f => !f.optional && !f.saved)) return 400;
  return `Photos: ${s.filter(f => f.saved).length} of ${s.length} saved. Fetch them with \`hq photos ${id}\`.`;
}

// ---------------------------------------------------------------- stripping
// JPEG: keep what decoding needs, plus JFIF, an ICC profile and Adobe's colour transform; drop Exif/XMP (APP1), MPF and
// every other APPn, and comments; stop at the primary image's EOI (iPhone HDR/portrait shots append more images, each
// with its own Exif). Anything that doesn't parse is refused.
const DECODE = new Set([0xdb, 0xc4, 0xcc, 0xdd, 0xdc, 0xde, 0xdf]); // DQT DHT DAC DRI DNL DHP EXP
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const starts = (b: Buffer, s: string) => b.subarray(0, s.length).equals(Buffer.from(s, 'latin1'));
function keepApp(m: number, payload: Buffer) {
  if (m === 0xe0) return starts(payload, 'JFIF\0');
  if (m === 0xe2) return starts(payload, 'ICC_PROFILE\0');
  if (m === 0xee) return starts(payload, 'Adobe');
  return false;
}
export function stripJpeg(buf: Buffer): Buffer | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const out: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let i = 2,
    frame = false,
    scans = 0;
  for (;;) {
    if (buf[i] !== 0xff) return null;
    while (buf[i] === 0xff) i++; // a marker, after any fill bytes
    if (i >= buf.length) return null;
    const m = buf[i++];
    if (m === 0xd9) {
      if (!scans) return null;
      out.push(Buffer.from([0xff, 0xd9]));
      return Buffer.concat(out);
    }
    const isApp = m >= 0xe0 && m <= 0xef;
    if (!isApp && m !== 0xfe && !DECODE.has(m) && !SOF.has(m) && m !== 0xda) return null; // SOI, RST, TEM, JPGn out of place
    if (i + 2 > buf.length) return null;
    const len = buf.readUInt16BE(i);
    if (len < 2 || i + len > buf.length) return null;
    const seg = Buffer.concat([Buffer.from([0xff, m]), buf.subarray(i, i + len)]);
    i += len;
    if (isApp) {
      if (keepApp(m, seg.subarray(4))) out.push(seg);
      continue;
    }
    if (m === 0xfe) continue; // COM
    if (SOF.has(m)) {
      if (frame) return null;
      frame = true;
    }
    out.push(seg);
    if (m !== 0xda) continue;
    // SOS: the entropy-coded data runs to the next marker that isn't a stuffed 0xFF00, a restart marker or a fill byte
    if (!frame) return null;
    let j = i;
    for (;;) {
      if (j + 1 >= buf.length) return null;
      if (buf[j] !== 0xff) {
        j++;
        continue;
      }
      const n = buf[j + 1];
      if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
        j += 2;
        continue;
      }
      if (n === 0xff) {
        j++;
        continue;
      }
      break;
    }
    out.push(buf.subarray(i, j));
    i = j;
    scans++;
  }
}

// PNG: keep the chunks that make the picture and its colour; drop eXIf, text, time and anything unknown. Chunks are
// copied whole, so their CRCs stay valid.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs']);
export function stripPng(buf: Buffer): Buffer | null {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const out: Buffer[] = [PNG_SIG];
  let i = 8,
    idat = false;
  for (;;) {
    if (i + 12 > buf.length) return null;
    const len = buf.readUInt32BE(i),
      type = buf.toString('latin1', i + 4, i + 8),
      end = i + 12 + len;
    if (len > 0x7fffffff || end > buf.length || !/^[A-Za-z]{4}$/.test(type)) return null;
    if (i === 8 && type !== 'IHDR') return null;
    if (PNG_KEEP.has(type)) out.push(buf.subarray(i, end));
    if (type === 'IDAT') idat = true;
    if (type === 'IEND') return idat ? Buffer.concat(out) : null;
    i = end;
  }
}

// ---------------------------------------------------------------- the board's upload (HQ session, HQ's own Origin)
// An open request with that photo field: its id and field index, or an HTTP status.
function openField(id: number, field: string | null) {
  const r =
    Number.isInteger(id) && id > 0
      ? (db.prepare('select status, photos from requests where id = ?').get(id) as
          { status: string; photos: string | null } | undefined)
      : undefined;
  if (!r?.photos) return 404;
  if (r.status !== 'open') return 409;
  const i = /^\d$/.test(field ?? '') ? Number(field) : -1;
  return i >= 0 && i < fieldsOf(r.photos).length ? i : 400;
}

// POST /api/requests/photo?id=<request>&field=<index>, the raw picture as the body (image/jpeg or image/png).
export async function upload(req: IncomingMessage, res: ServerResponse) {
  const q = new URL(req.url ?? '/', 'http://x').searchParams,
    id = Number(q.get('id'));
  const fail = async (code: number, error: string) => {
    await reply(res, code, { error }, true);
    req.destroy();
  };
  const i = openField(id, q.get('field'));
  if (i === 404) return fail(404, 'no such request with photos');
  if (i === 409) return fail(409, 'that request is already answered');
  if (i === 400) return fail(400, 'no such photo field');
  const type = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (type !== 'image/jpeg' && type !== 'image/png') return fail(415, 'a JPEG or PNG only');
  const raw = await readBody(req, MAX_BYTES);
  if (!raw) return fail(413, 'too large');
  const clean = type === 'image/png' ? stripPng(raw) : stripJpeg(raw);
  if (!clean) return reply(res, 400, { error: 'not a picture we can read' });
  const again = openField(id, String(i)); // answered while the picture was on its way
  if (again !== i) return reply(res, 409, { error: 'that request is already answered' });
  const ext = type === 'image/png' ? 'png' : 'jpg',
    dir = `${DIR}/${id}`,
    tmp = `${dir}/.${i}-${randomBytes(4).toString('hex')}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(tmp, clean, { mode: 0o600 });
  renameSync(tmp, `${dir}/${i}.${ext}`);
  rmSync(`${dir}/${i}.${ext === 'png' ? 'jpg' : 'png'}`, { force: true });
  return reply(res, 200, { ok: true, field: i, bytes: clean.length });
}

// ---------------------------------------------------------------- the asking agent (worker token): hq photos <id>
export function forWorker(id: number) {
  const r = db.prepare('select photos from requests where id = ?').get(id) as { photos: string | null } | undefined;
  if (!r?.photos) return 404;
  return fieldsOf(r.photos).map((f, i) => {
    const p = fileOf(id, i);
    // (shot: the studio takes product photos only)
    return {
      field: i,
      label: f.label,
      optional: !!f.optional,
      ...(f.shot && { shot: f.shot }),
      saved: !!p,
      type: p ? (p.endsWith('.png') ? 'image/png' : 'image/jpeg') : null,
      bytes: p ? statSync(p).size : 0,
    };
  });
}
// The file of a saved photo (the board's archive serves it: jobs.ts archivePhoto), or undefined.
export const fileFor = (id: number, field: number) =>
  Number.isInteger(id) && Number.isInteger(field) && field >= 0 ? fileOf(id, field) : undefined;
export function photoForWorker(id: number, field: number) {
  const p = fileFor(id, field);
  if (!p) return 404;
  return { type: p.endsWith('.png') ? 'image/png' : 'image/jpeg', data: readFileSync(p).toString('base64') };
}
