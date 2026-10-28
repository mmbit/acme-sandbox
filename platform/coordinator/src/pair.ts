// One-time device codes sign another of the board's devices into its existing Notebook.
import { createHmac, randomInt } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db, remember, setting } from './db.ts';
import { clientOf, startSession } from './auth.ts';
import { serverKey } from './secrets.ts';

const KEY = serverKey('pairlogin');
const CODE_MS = 60_000;
const ATTEMPTS_PER_MINUTE = 5;
// Ten wrong guesses across all clients cap exposure of the six-digit board sign-in code.
const MAX_WRONG_GUESSES = 10;
const hash = (value: string) => createHmac('sha256', KEY).update(value).digest('hex');
db.exec(`create table if not exists notebook_pair_codes (hash text primary key, owner text not null, expires integer not null);
  create table if not exists notebook_pair_attempts (client text not null, at integer not null)`);

export function createCode(req: IncomingMessage) {
  const now = Date.now();
  const owner = hash(req.headers.cookie ?? '');
  db.prepare('delete from notebook_pair_codes where expires <= ? or owner = ?').run(now, owner);
  if (!db.prepare('select 1 from notebook_pair_codes where expires > ?').get(now)) remember('pair_wrong_guesses', null);
  let code: string;
  do {
    code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  } while (db.prepare('select 1 from notebook_pair_codes where hash = ?').get(hash(code)));
  db.prepare('insert into notebook_pair_codes (hash, owner, expires) values (?, ?, ?)').run(
    hash(code),
    owner,
    now + CODE_MS,
  );
  return { code, expires: now + CODE_MS };
}

export async function joinDevice(req: IncomingMessage, res: ServerResponse, body: any) {
  const client = await clientOf(req),
    now = Date.now();
  db.prepare('delete from notebook_pair_attempts where at <= ?').run(now - CODE_MS);
  const { n } = db.prepare('select count(*) n from notebook_pair_attempts where client = ?').get(client) as {
    n: number;
  };
  if (n >= ATTEMPTS_PER_MINUTE) return 429;
  db.prepare('insert into notebook_pair_attempts (client, at) values (?, ?)').run(client, now);
  const code = String(body?.code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return 400;
  const found = db
    .prepare('delete from notebook_pair_codes where hash = ? and expires > ? returning hash')
    .get(hash(code), now);
  if (!found) {
    recordWrongGuess(now);
    return 403;
  }
  startSession(res);
  return { ok: true };
}

function recordWrongGuess(now: number) {
  if (!db.prepare('select 1 from notebook_pair_codes where expires > ?').get(now)) return;
  const guesses = Number(setting('pair_wrong_guesses') ?? 0) + 1;
  remember('pair_wrong_guesses', String(guesses));
  if (guesses >= MAX_WRONG_GUESSES) db.exec('delete from notebook_pair_codes');
}

export const pairPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in on this device</title><link rel="stylesheet" href="/pair/signin.css"><main><h1>Bring your Notebook</h1>
<p>On a device already signed in, open the Notebook’s Shelf and choose “Sign in another device”.</p>
<form><label for="code">One-time code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus>
<button>Sign in on this device</button></form><p role="alert"></p><a href="/login">Use a passkey instead</a></main><script type="module" src="/pair/signin.js"></script></html>`;
