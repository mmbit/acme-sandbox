// HQ's seal for a product's backup files: a product hands HQ its payload and gets it back sealed, so only HQ can open it,
// and only for the product and mode that sealed it.
//   POST /api/pay/backup/seal {payload} → {sealed}    POST /api/pay/backup/open {sealed} → {payload}    (both base64)
// A product's own token, as for every /api/pay/* route (payments.ts caller). AES-256-GCM under HQ's newest backup key,
// with the product's slug and mode as associated data. The sealed bytes: a format byte, the key's id (4 bytes), the
// slug's length and the slug, the mode (0 test, 1 live), a random 12-byte nonce, then the ciphertext and its 16-byte tag.
// Everything before the nonce is authenticated too. Refusals: 413 too_big, 422 damaged (changed, cut short, a key HQ
// doesn't have), 403 other_stall (another product's file, or the other mode's).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DATA_DIR } from './config.ts';
import { caller, json, type Caller } from './payments.ts';
import { parseJson, readBody } from '../../../shared/routes/routes.ts';

// One file per key, <id>.key (64 hex characters, mode 600), beside payments.key and in the nightly backup with it. Its
// id is the second it was made, so the newest is the largest. Every key stays: a file sealed years ago still opens.
const KEYS_DIR = `${DATA_DIR}/backup-keys`;
const KEY_ID = /^(\d{1,10})\.key$/;
const NEW_KEY_AFTER_MS = 365 * 86_400_000; // a new key seals from a year after the last was made
export const PAYLOAD_MAX_BYTES = 20 * 1024 * 1024;
const BODY_MAX_BYTES = Math.ceil(((PAYLOAD_MAX_BYTES + 1024) * 4) / 3) + 1024; // either payload as base64, in JSON
const FORMAT = 1;
const NONCE_BYTES = 12,
  TAG_BYTES = 16;
const MODES = ['test', 'live'] as const;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

type Refused = [number, string, string?];

export async function handle(req: IncomingMessage, res: ServerResponse) {
  const route = `${req.method} ${new URL(req.url ?? '/', 'http://x').pathname}`;
  const c = caller(req);
  if (Array.isArray(c)) {
    req.resume();
    return json(res, c[0], { error: c[1] });
  }
  if (route !== 'POST /api/pay/backup/seal' && route !== 'POST /api/pay/backup/open') {
    req.resume();
    return json(res, 404, { error: 'not found' });
  }
  const raw = await readBody(req, BODY_MAX_BYTES);
  if (!raw) return refuse(res, [413, 'a backup carries at most 20 MB', 'too_big']);
  const sent = parseJson(raw);
  const body: Record<string, unknown> | null = sent && typeof sent === 'object' ? sent : null;
  const field = route.endsWith('/seal') ? 'payload' : 'sealed';
  const text = body?.[field];
  if (typeof text !== 'string' || text.length % 4 !== 0 || !BASE64.test(text))
    return json(res, 400, { error: `a JSON body with ${field} in base64` });
  const bytes = Buffer.from(text, 'base64');
  const answer = field === 'payload' ? seal(c, bytes) : open(c, bytes);
  if (Array.isArray(answer)) return refuse(res, answer);
  return json(res, 200, { [field === 'payload' ? 'sealed' : 'payload']: answer.toString('base64') });
}

const refuse = (res: ServerResponse, [status, error, why]: Refused) => json(res, status, { error, why });

// The payload sealed for this product and mode, under the newest key
export function seal(c: Caller, payload: Buffer): Buffer | Refused {
  if (payload.length > PAYLOAD_MAX_BYTES) return [413, 'a backup carries at most 20 MB', 'too_big'];
  const { id, key } = sealingKey();
  const header = headerOf(id, c);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([header, nonce, ciphertext, cipher.getAuthTag()]);
}

// The payload again, if this product and mode sealed it and nothing in it changed
export function open(c: Caller, sealed: Buffer): Buffer | Refused {
  const damaged: Refused = [422, 'this backup is changed or damaged', 'damaged'];
  if (sealed.length < 7 || sealed[0] !== FORMAT) return damaged;
  const slugEnd = 6 + sealed[5];
  const slug = sealed.toString('latin1', 6, slugEnd),
    mode = MODES[sealed[slugEnd]];
  if (sealed.length < slugEnd + 1 + NONCE_BYTES + TAG_BYTES || !mode) return damaged;
  if (slug !== c.slug || mode !== c.mode) return [403, "this backup is another product's", 'other_stall'];
  const key = keyOf(sealed.readUInt32BE(1));
  if (!key) return damaged;
  const header = sealed.subarray(0, slugEnd + 1),
    nonce = sealed.subarray(slugEnd + 1, slugEnd + 1 + NONCE_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(header);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(slugEnd + 1 + NONCE_BYTES, -TAG_BYTES)), decipher.final()]);
  } catch {
    return damaged;
  }
}

function headerOf(id: number, c: Caller) {
  const slug = Buffer.from(c.slug, 'latin1');
  const header = Buffer.alloc(7 + slug.length);
  header[0] = FORMAT;
  header.writeUInt32BE(id, 1);
  header[5] = slug.length;
  slug.copy(header, 6);
  header[6 + slug.length] = MODES.indexOf(c.mode);
  return header;
}

// ---- the keys

const keys = new Map<number, Buffer>();

// The newest key, made first when there's none or the newest is a year old
function sealingKey() {
  const ids = keyIds();
  const newest = ids.length ? Math.max(...ids) : 0;
  const id = newest * 1000 > Date.now() - NEW_KEY_AFTER_MS ? newest : makeKey(newest);
  return { id, key: keyOf(id)! };
}

function keyIds() {
  mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  return readdirSync(KEYS_DIR).flatMap(name => {
    const id = KEY_ID.exec(name)?.[1];
    return id ? [Number(id)] : [];
  });
}

// A new key, its id the second it's made (after the newest's, whatever the clock says)
function makeKey(newest: number) {
  const id = Math.max(Math.floor(Date.now() / 1000), newest + 1);
  try {
    writeFileSync(`${KEYS_DIR}/${id}.key`, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    console.log(`Backup keys: made key ${id}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; // else made meanwhile, by a seal at the same second
  }
  return id;
}

function keyOf(id: number) {
  if (!keys.has(id)) {
    let text: string;
    try {
      text = readFileSync(`${KEYS_DIR}/${id}.key`, 'utf8').trim();
    } catch {
      return null;
    }
    if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`Backup keys: key ${id} isn't 64 hex characters`);
    keys.set(id, Buffer.from(text, 'hex'));
  }
  return keys.get(id)!;
}
