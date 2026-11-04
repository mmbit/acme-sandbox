// One-time pair codes open the page HQ's viewer shows on another device, scanned from the viewer's QR or typed at
// /pair: the device gets a view-only share of that page (shares.ts forDevice) for an hour, never HQ and never the
// board's own access. HQ opens on the board's own devices with their passkeys (auth.ts).
import { createHmac, randomInt } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { db, remember, setting } from './db.ts';
import { clientOf } from './auth.ts';
import { linkedFrom, scopeOf } from './feedback.ts';
import { HANDED_ACCESS_MS, LINK_MS } from './preview.ts';
import * as shares from './shares.ts';
import { serverKey } from './secrets.ts';

const KEY = serverKey('pairlogin');
const CODE_MS = 60_000;
const ATTEMPTS_PER_MINUTE = 5;
// Ten wrong guesses across all clients cap exposure of the six-digit code.
const MAX_WRONG_GUESSES = 10;
const hash = (value: string) => createHmac('sha256', KEY).update(value).digest('hex');
// target: the page the code opens, one a share can open (feedback.ts scopeOf)
db.exec(`create table if not exists pair_codes (hash text primary key, owner text not null, expires integer not null, target text not null);
  create table if not exists pair_attempts (client text not null, at integer not null)`);

// POST /api/pair-codes {url}: a code for the page url in HQ's viewer, or 400 for a page no share opens
export function createCode(req: IncomingMessage, body: any) {
  const target = String(body?.url ?? '');
  if (!scopeOf(target)) return 400;
  const now = Date.now();
  const owner = hash(req.headers.cookie ?? '');
  db.prepare('delete from pair_codes where expires <= ? or owner = ?').run(now, owner);
  if (!db.prepare('select 1 from pair_codes where expires > ?').get(now)) remember('pair_wrong_guesses', null);
  let code: string;
  do {
    code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  } while (db.prepare('select 1 from pair_codes where hash = ?').get(hash(code)));
  db.prepare('insert into pair_codes (hash, owner, expires, target) values (?, ?, ?, ?)').run(
    hash(code),
    owner,
    now + CODE_MS,
    target,
  );
  return { code, expires: now + CODE_MS };
}

// POST /api/pair-codes/open {code} → { url }: the one-time link to the code's page on this device. No cookie of HQ's.
export async function openCode(req: IncomingMessage, body: any) {
  const client = await clientOf(req),
    now = Date.now();
  db.prepare('delete from pair_attempts where at <= ?').run(now - CODE_MS);
  const { n } = db.prepare('select count(*) n from pair_attempts where client = ?').get(client) as { n: number };
  if (n >= ATTEMPTS_PER_MINUTE) return 429;
  db.prepare('insert into pair_attempts (client, at) values (?, ?)').run(client, now);
  const code = String(body?.code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return 400;
  const found = db
    .prepare('delete from pair_codes where hash = ? and expires > ? returning target')
    .get(hash(code), now) as { target: string } | undefined;
  if (!found) {
    recordWrongGuess(now);
    return 403;
  }
  const scope = scopeOf(found.target)!;
  return { url: shares.forDevice(scope, linkedFrom(scope), { linkMs: LINK_MS, accessMs: HANDED_ACCESS_MS }) };
}

function recordWrongGuess(now: number) {
  if (!db.prepare('select 1 from pair_codes where expires > ?').get(now)) return;
  const guesses = Number(setting('pair_wrong_guesses') ?? 0) + 1;
  remember('pair_wrong_guesses', String(guesses));
  if (guesses >= MAX_WRONG_GUESSES) db.exec('delete from pair_codes');
}
