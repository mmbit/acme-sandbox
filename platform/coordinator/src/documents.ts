// Document fields on desk-phone requests: an agent asks the board for files only the board can get (an invoice from a
// billing page, a signed form) with hq ask/request --document "label" --documents-to <address>, the board picks each
// file on its tablet next to the answer box, and the answer files each one as mail to that address (mail.ts fileMail).
//   - The address is one of the company's own, never one for the board alone. It decides how long a file is kept and
//     where it goes off the server, as for mail that came there (invoices@: as an invoice). The agent reads it with hq
//     mail.
//   - A file is kept exactly as uploaded, since an invoice must be kept in the form it came in: no re-encoding. Its
//     first bytes must say it's a PDF, a JPEG or a PNG.
//   - Until the answer, uploads wait in documents/<request>/<field> (0700/0600), and the request's field keeps the
//     file's name and type. The answer moves them into Mail. A card that leaves the desk phone unanswered loses them
//     within the hour (sweep).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db } from './db.ts';
import { DATA_DIR } from './config.ts';
import { readBody } from '../../../shared/routes/routes.ts';
import { keepFile, refuse, reply } from './uploads.ts';
import * as photos from './photos.ts';
import * as mail from './mail.ts';

export const DIR = `${DATA_DIR}/documents`;
// An invoice downloaded from a billing page is well under 1 MB; a scanned contract can be a few.
export const MAX_BYTES = 10 * 1024 * 1024;
mkdirSync(DIR, { recursive: true, mode: 0o700 });

// upload: the file waiting for the answer; mail: the mail it was filed as
export type Field = {
  label: string;
  optional?: true;
  to: string;
  upload?: { name: string; type: string };
  mail?: number;
};

// ---------------------------------------------------------------- the fields
// A request's document fields from what the agent sent: labels as for photo fields, each with its address (to).
// undefined for none, null when they don't make sense.
export function parseFields(v: unknown): Field[] | null | undefined {
  const labels = photos.parseLabels(v); // (no photo's shot on a document)
  if (!labels) return labels;
  const fields = labels.map((f, i) => {
    const to = mail.ownAddress((v as { to?: unknown }[])[i]?.to);
    return to ? { ...f, to } : null;
  });
  return fields.every(f => f) ? (fields as Field[]) : null;
}

const fieldsOf = (json: string | null) => photos.fieldsOf<Field>(json);
const fileOf = (id: number, i: number) => `${DIR}/${id}/${i}`;
const waiting = (id: number, f: Field, i: number) => !!f.upload && existsSync(fileOf(id, i));
// Every upload waiting for an answer, but the one a new file would replace, by size: they become mail, so they count
// against Mail's room before they do.
function waitingSizes(except: string) {
  const sizes: number[] = [];
  for (const request of readdirSync(DIR)) {
    const files = readdirSync(`${DIR}/${request}`)
      .map(f => `${DIR}/${request}/${f}`)
      .filter(f => f !== except);
    sizes.push(...files.map(f => statSync(f).size));
  }
  return sizes;
}
// Each file becomes a mail of its own: a file and its folder in Mail (mail.ts room).
const asMail = (sizes: number[]) => ({ files: sizes, folders: sizes.length });

// What the desk phone shows: each field, where it goes, and the file picked for it (or the mail it became).
export const state = (id: number, json: string | null) =>
  fieldsOf(json).map((f, i) => ({
    label: f.label,
    optional: !!f.optional,
    to: f.to,
    saved: !!f.mail || waiting(id, f, i),
    name: f.upload?.name ?? null,
    mail: f.mail ?? null,
  }));

// ---------------------------------------------------------------- the board's upload (HQ session, HQ's own Origin)
// The first bytes say what a file is; the name and the browser's type don't count.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function typeOf(b: Buffer) {
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return b.subarray(0, 8).equals(PNG_SIG) ? 'image/png' : null;
}
const EXTENSION: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

// An open request with that document field, not yet filed: its fields and the field's index, or an HTTP status (409
// also for a field filed by an answer that failed part-way: its mail holds the file, so it can't be replaced any more).
function openField(id: number, field: string | null) {
  const r =
    Number.isInteger(id) && id > 0
      ? (db.prepare('select status, documents from requests where id = ?').get(id) as
          { status: string; documents: string | null } | undefined)
      : undefined;
  if (!r?.documents) return 404;
  if (r.status !== 'open') return 409;
  const fields = fieldsOf(r.documents),
    i = /^\d$/.test(field ?? '') ? Number(field) : -1;
  if (i < 0 || i >= fields.length) return 400;
  return fields[i].mail ? 409 : { fields, i };
}

// POST /api/requests/document?id=<request>&field=<index>&name=<the file's name>, the file as it is as the body.
export async function upload(req: IncomingMessage, res: ServerResponse) {
  const q = new URL(req.url ?? '/', 'http://x').searchParams,
    id = Number(q.get('id'));
  const open = openField(id, q.get('field'));
  if (open === 404) return refuse(req, res, 404, 'no such request with document fields');
  if (open === 409) return refuse(req, res, 409, 'that request is already answered, or that file already filed');
  if (open === 400) return refuse(req, res, 400, 'no such document field');
  const file = await readBody(req, MAX_BYTES);
  if (!file) return refuse(req, res, 413, 'too large');
  const type = typeOf(file);
  if (!type) return reply(res, 415, { error: 'a PDF, JPEG or PNG only' });
  if (!mail.room(asMail([file.length, ...waitingSizes(fileOf(id, open.i))])))
    return reply(res, 507, { error: 'mail storage is full or the disk is low' });
  const again = openField(id, String(open.i)); // answered (or filed) while the file was on its way
  if (typeof again === 'number')
    return reply(res, 409, { error: 'that request is already answered, or that file already filed' });
  const given = mail.cleanName(q.get('name') ?? '').trim();
  const slug = again.fields[open.i].label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');
  // (a name the browser didn't send)
  const name = given && given !== 'attachment' ? given : `${slug || 'document'}.${EXTENSION[type]}`;
  keepFile(fileOf(id, open.i), file);
  again.fields[open.i].upload = { name, type };
  db.prepare('update requests set documents = ? where id = ?').run(JSON.stringify(again.fields), id);
  return reply(res, 200, { ok: true, field: open.i, name, bytes: file.length });
}

// ---------------------------------------------------------------- the answer: each file becomes a mail
// answerRequest: every required file must be in, and Mail must have room for them all. Files each one as a mail from
// the board to its field's address, and returns the line the agent's answer ends with; or 400 (a required file is
// missing), or 507 (no room in Mail: nothing is filed, the card stays open). Each mail's id is kept as it's filed, so
// answering again after a failure part-way files only the rest.
export function fileAll(id: number, title: string, json: string) {
  const fields = fieldsOf(json),
    picked = fields.map((f, i) => waiting(id, f, i));
  if (fields.some((f, i) => !f.optional && !picked[i])) return 400;
  const sizes = fields.flatMap((f, i) => (picked[i] && !f.mail ? [statSync(fileOf(id, i)).size] : []));
  if (sizes.length && !mail.room(asMail(sizes))) return 507;
  fields.forEach((f, i) => {
    if (!picked[i] || f.mail) return;
    f.mail = mail.fileMail({
      sender: 'the board (desk phone)',
      recipient: f.to,
      subject: `${title}: ${f.label}`,
      text:
        `The board added this file on the desk phone, to request #${id} ("${title}"), in the field "${f.label}". ` +
        'It is attached as the board uploaded it.',
      file: { name: f.upload!.name, type: f.upload!.type, bytes: readFileSync(fileOf(id, i)) },
    });
    db.prepare('update requests set documents = ? where id = ?').run(JSON.stringify(fields), id);
  });
  rmSync(`${DIR}/${id}`, { recursive: true, force: true });
  const lines = fields.map(f =>
    f.mail ? `- ${f.label}: mail #${f.mail} to ${f.to} (${f.upload!.name})` : `- ${f.label}: left empty`,
  );
  const filed = fields.filter(f => f.mail).length;
  return `Documents: ${filed} of ${fields.length} filed as mail. Read each with \`hq mail <id>\`:\n${lines.join('\n')}`;
}

// Hourly, and at the start: uploads for a card that left the desk phone without an answer (closed, or replaced) go.
export function sweep() {
  for (const name of readdirSync(DIR)) {
    const open =
      /^\d+$/.test(name) && db.prepare("select 1 from requests where id = ? and status = 'open'").get(Number(name));
    if (!open) rmSync(`${DIR}/${name}`, { recursive: true, force: true });
  }
}
sweep();
setInterval(() => {
  try {
    sweep();
  } catch (e) {
    console.error('documents: the sweep failed:', e);
  }
}, 3_600_000).unref();
