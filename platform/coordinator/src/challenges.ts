// Bounded, single-use passkey challenges, kept through coordinator restarts.
import { db, lacks, once } from './db.ts';

db.exec(`create table if not exists challenges (key text primary key, challenge text not null, expires integer not null,
  client text not null, audience text not null default 'board', context text not null default '{}')`);
for (const column of ["audience text not null default 'board'", "context text not null default '{}'"])
  if (lacks('challenges', column.split(' ')[0])) db.exec(`alter table challenges add column ${column}`);
// An older table keeps a board enrollment's hash in a column of its own: it moves into the context, so an enrollment
// under way still finishes
if (!lacks('challenges', 'enroll_hash'))
  db.exec(`update challenges set context = json_object('enrollHash', enroll_hash) where enroll_hash is not null;
    alter table challenges drop column enroll_hash`);
once('2026-10-28-shared-guest-challenges', () => {
  if (!db.prepare("select 1 from sqlite_master where type = 'table' and name = 'guest_challenges'").get()) return;
  db.exec(`insert into challenges (key, challenge, expires, client, audience, context)
    select key, challenge, expires, client, 'guest', json_object('name', guest, 'email', email,
      'purpose', purpose, 'scope', scope, 'session', session) from guest_challenges;
    drop table guest_challenges`);
});

type Audience = 'board' | 'guest';
type Row = { challenge: string; expires: number; client: string; context: string };
export const CHALLENGE_MS = 5 * 60_000;
// A client holds only its five newest challenges. A full audience refuses new ones rather than evicting another
// person's sign-in. Board and guest budgets stay separate so a guest flood cannot displace a board sign-in.
const PER_CLIENT = 5,
  MAX_PENDING = 2000;

// `context`: what the audience checks the answer against
export function hold(audience: Audience, key: string, client: string, challenge: string, context: object) {
  db.prepare('delete from challenges where audience = ? and expires <= ?').run(audience, Date.now());
  const mine = db
    .prepare('select key from challenges where audience = ? and client = ? order by rowid')
    .all(audience, client) as { key: string }[];
  if (mine.length >= PER_CLIENT) db.prepare('delete from challenges where key = ?').run(mine[0].key);
  const count = db.prepare('select count(*) n from challenges where audience = ?').get(audience) as { n: number };
  if (count.n >= MAX_PENDING) return false;
  db.prepare(
    'insert into challenges (key, challenge, expires, client, audience, context) values (?, ?, ?, ?, ?, ?)',
  ).run(key, challenge, Date.now() + CHALLENGE_MS, client, audience, JSON.stringify(context));
  return true;
}

export function take<Context extends object>(audience: Audience, key: string) {
  const row = db.prepare('delete from challenges where audience = ? and key = ? returning *').get(audience, key) as
    Row | undefined;
  if (!row || row.expires <= Date.now()) return;
  return { challenge: row.challenge, client: row.client, context: JSON.parse(row.context) as Context };
}

export function forgetGuest(name: string) {
  db.prepare(
    "delete from challenges where audience = 'guest' and json_extract(context, '$.name') = ? collate nocase",
  ).run(name);
}
