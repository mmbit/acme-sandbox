// Care's database: SQLite in DATA_DIR (its own volume), or in memory for a run without one. Everything a customer said is
// kept by conversation and email, so one lookup answers an access request and one delete erases it.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { DATA_DIR, LINK_KEY } from './config.ts';

// A DATA_DIR that's set (the server's volume) and can't be used stops the service: in memory, sessions, codes, the link
// key and the cases waiting for HQ would vanish at the next restart without a word.
export let db: DatabaseSync;
try { mkdirSync(DATA_DIR, { recursive: true }); db = new DatabaseSync(join(DATA_DIR, 'care.db'), { timeout: 5000 }); }
catch (err: any) {
  if (process.env.DATA_DIR) throw new Error(`care: can't use DATA_DIR (${err?.code ?? err?.message})`);
  console.error(`care: no DATA_DIR and ${DATA_DIR} can't be used (${err?.code ?? err?.message}): the database is in memory, gone at a restart`);
  db = new DatabaseSync(':memory:');
}
// Erased means gone from every file: secure_delete overwrites a deleted row's page, and the rollback journal holding the
// page as it was before is deleted at the commit. Write-ahead would keep that old page readable in care.db-wal, after a
// checkpoint too. A file still in write-ahead switches back only while no other process has it open: a held one stops
// the start ("database is locked"), so Care never takes a case it couldn't erase, and the restart switches it.
db.exec('pragma secure_delete = on; pragma foreign_keys = on;');
const journal = (db.prepare('pragma journal_mode = delete').get() as { journal_mode: string }).journal_mode;
if (journal !== 'delete' && journal !== 'memory') throw new Error(`care: care.db stays ${journal}, so erased text would stay in its journal`);

// Every create statement includes all of the table's columns.
db.exec(`
-- a device's session: the cookie holds a random id, this table only its hash. Grants live here, written only by the
-- verify handlers (session.ts, gate.ts): orders checked at level 1 (each with its app), and an email checked by code or
-- signed link. A session is a shop's (X-Care-Shop: every stall on one origin), never one stall's
create table if not exists sessions (id text primary key, shop text not null, conversation integer, created integer not null,
  seen integer not null, orders text not null default '[]', order_email text, email text, email_at integer, email_seen integer, rotate integer not null default 0,
  rotate_tab text, rotate_at integer);
-- one conversation: the session's until level 2, then the thread for (shop, email) with the earlier ones. summarized:
-- when it was last summed up. kind: 'phone' for a phone call (phone.ts), null for a chat. linked: when an emailed code
-- linked a call to an order, which keeps it 12 months as a chat linked to an email is kept
create table if not exists conversations (id integer primary key, shop text not null, email text, created integer not null,
  last integer not null, summary text, state text not null default '{}', summarized integer, kind text, linked integer);
-- health: a customer's message with a health detail (engine.ts): 'held' (its card is open; no model sees it),
-- 'person' (sent to a person with the customer's consent; no model sees it either), 'removed' (the helper found one the
-- check missed: the text is gone). ai_generated: 1 on a helper's message the model wrote, null on a template's (the
-- machine-readable AI mark, AI Act art. 50(2)). who: the customer's ('me') or the helper's ('ai'). tab: the hash of the
-- x-care-tab the message came from (a grant a value in it proves is held for that page, helper.ts typedOn()). app: the
-- stall it came from (its X-Care-App: Numbers counts a shop's conversations per app by it). lang: the language a phone
-- reply was spoken in (phonecall.ts store)
create table if not exists messages (id integer primary key, conversation integer not null references conversations on delete cascade,
  at integer not null, who text not null, text text not null default '', widget text, answer text, client text, tab text, health text,
  ai_generated integer, app text, lang text);
create index if not exists messages_conversation on messages (conversation, id);
-- what a confirmation button does, written by the server from a template; the tap sends only the id
create table if not exists actions (id text primary key, conversation integer not null references conversations on delete cascade,
  session text not null, shop text not null, kind text not null, args text not null, created integer not null,
  expires integer not null, used integer, result text);
create table if not exists codes (id integer primary key, session text not null, email text not null, hash text not null,
  created integer not null, tries integer not null default 0, used integer);
create table if not exists nonces (nonce text primary key, used integer not null);
-- rate limits: one row per counted event, keyed by what's limited (hashed: an IP or an email never sits here in clear)
create table if not exists hits (key text not null, at integer not null);
create index if not exists hits_key on hits (key, at);
-- a row per model call: what it was for, the tokens and what it cost, in dollars too (usd), so the prepaid credit
-- (ledger.ts credit()) counts what was spent whatever the euro rate since
create table if not exists ledger (id integer primary key, at integer not null, app text not null, conversation integer,
  session text, ip text, purpose text not null, model text not null, input integer not null, cache_write integer not null,
  cache_read integer not null, output integer not null, eur real not null, estimate integer not null default 0, usd real);
create index if not exists ledger_at on ledger (at);
create index if not exists ledger_conversation on ledger (conversation);
-- what goes to a person (HQ's Care app): an email to a person, a question for the team, a data request (rights.ts), a
-- claim for a partner, a bug report.
-- Its id is its public reference (H-1000+id), and HQ keeps the references it deleted or marked fixed for 90 days
-- (erased, fixed): an id is never issued twice, even after the newest case is deleted (AUTOINCREMENT). draft: a
-- person card's draft for the board (drafts.ts). held: held back by a company's own tool, or 'address' for a data
-- request waiting for its reply address: it goes to HQ once that's cleared. answer, answered, answered_hq,
-- answer_tried: a question answered from a knowledge entry (answers.ts), the email waiting to go, when it went, when HQ
-- heard, the knowledge it couldn't answer from. health: 1 if a health detail
-- went to a person with it, so no model drafts for it; health_hq: when HQ heard so (with the first card, or in a 'more'
-- for a case marked after HQ had it, hq.ts)
create table if not exists cases (id integer primary key autoincrement, app text not null,
  conversation integer references conversations on delete set null, kind text not null, email text, checked text not null,
  words text not null default '', summary text, facts text, lang text, created integer not null, sent_hq integer, hq_id text,
  decision text, chat_to integer, draft text, drafted integer, failed integer, draft_sent integer, held text, answer text,
  answered integer, answered_hq integer, answer_tried text, health integer, health_hq integer);
-- a bug report's bundle (the page's picture and short log), sent only from the consent card's "Send it"; stored as data,
-- shown in HQ as text. Deleting the conversation deletes it; HQ's "fixed" or 90 days, whichever comes first, delete it
-- with its bug case (diagnostics.ts, sweep())
create table if not exists diagnostics (id integer primary key, conversation integer not null references conversations on delete cascade,
  case_id integer not null references cases on delete cascade, created integer not null, bundle text not null);
create index if not exists diagnostics_case on diagnostics (case_id);
-- a claim's photo (photos.ts): a fresh JPEG under a random id in DATA_DIR/photos, outside any web root, never
-- sent to the model. kind: the rules' case; claim: the case it went to HQ with. bytes 0: being decoded. replaced: a re-take
-- took its place (its file is gone, the row stays: it still counts toward the case's 6)
create table if not exists photos (id text primary key, conversation integer references conversations on delete cascade,
  app text not null, order_id text not null, kind text not null, shot text not null, bytes integer not null, width integer,
  height integer, created integer not null, claim integer references cases on delete set null, sent_hq integer, replaced integer);
create index if not exists photos_conversation on photos (conversation, order_id, kind);
-- the question log: one generalised line per finished conversation, with no link back to it
create table if not exists questions (id integer primary key, app text not null, day text not null, line text not null);
-- the board's "Ask for changes" care has answered (drafts.ts): HQ's id for each ask, so one is never redrafted twice
create table if not exists redrafts (ask text primary key, at integer not null);
-- HQ's wants care has answered for its own cards (inbox.ts: an email's draft): the id only
create table if not exists hq_wants (id text primary key, at integer not null);
-- what HQ's state said that care keeps through a restart: 'board', the board's language (texts.ts boardLang)
create table if not exists hq_said (key text primary key, value text not null);
-- the board's warnings about the prepaid credit HQ has (ledger.ts creditWarning()): per credit (amount@time) and step, in
-- dollars
create table if not exists credit_warnings (credit text not null, step real not null, at integer not null, primary key (credit, step));
-- the model's tool calls, for the eval: written only on a local run and a preview app (toollog.ts), never a live app's
create table if not exists tool_log (id integer primary key, conversation integer not null references conversations on delete cascade,
  at integer not null, name text not null, input text not null, level integer not null, result text);
create index if not exists tool_log_conversation on tool_log (conversation, id);
-- the helper's measures (numbers.ts): counts per app and day (the company's time zone) with no conversation, customer or order ("Did this help?",
-- first words in 100 ms steps); the times the helper couldn't answer (kind 'breaker': the provider, app '' for every app;
-- 'cap': ours, app '' for the month's and the credit's); and each finished day's
-- counts for HQ, kept until HQ has them and after
create table if not exists tallies (app text not null, day text not null, name text not null, n integer not null, primary key (app, day, name));
create table if not exists downtime (id integer primary key, kind text not null, app text not null, start integer not null, last integer not null,
  until integer, end integer);
create table if not exists numbers (app text not null, day text not null, counts text not null, made integer not null, sent integer, primary key (app, day));
`);
// A phone call's codes (phone.ts): one per stall of the shop for each code asked for, each hash with its stall and the order
// number as said. `round` groups one ask's codes (a new ask replaces the last), and its tries are counted on every row of
// the round
// (lang, on a database from before it)
if (!(db.prepare('pragma table_info(messages)').all() as { name: string }[]).some(c => c.name === 'lang'))
  db.exec('alter table messages add column lang text');
db.exec(`create table if not exists phone_codes (id integer primary key, conversation integer not null references conversations on delete cascade,
  round integer not null, app text not null, order_id text not null, hash text not null, created integer not null,
  tries integer not null default 0, used integer);
create index if not exists phone_codes_conversation on phone_codes (conversation, round);`);
// An answer by email a caller asked for (phoneanswer.ts): one a call and order number, its questions in order, kept only
// until it has gone. email: the answer written, waiting for its stall to have it sent ({ app, text }); tries and next:
// the asks that failed and when it's tried again
db.exec(`create table if not exists phone_answers (conversation integer not null references conversations on delete cascade,
  order_id text not null, questions text not null, lang text not null, created integer not null, email text,
  tries integer not null default 0, next integer not null default 0, primary key (conversation, order_id))`);
db.exec('create index if not exists conversations_email on conversations (shop, email)');

// What HQ's state lists by case reference (`fixed`, `erased`): every reference it gives, each run on its case id, in one
// transaction. HQ keeps them 90 days, so no cap: one would leave everything past it undone for good. Returns the rows changed.
export function byRef(refs: unknown, run: (id: number) => number | bigint) {
  if (!Array.isArray(refs)) return 0;
  let n = 0;
  db.exec('begin immediate');
  try {
    for (const ref of refs) {
      const m = /^H-(\d{4,9})$/.exec(String(ref));
      if (m) n += Number(run(Number(m[1]) - 1000));
    }
    db.exec('commit');
  } catch (err) { db.exec('rollback'); throw err; }
  return n;
}

export const now = () => Date.now();
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const token = (bytes = 24) => randomBytes(bytes).toString('base64url');

// The signing key for links in our emails: from the environment, or made once and kept on the volume (0600).
export const linkKey = (() => {
  if (LINK_KEY) return LINK_KEY;
  const path = join(DATA_DIR, 'link.key');
  try { return readFileSync(path, 'utf8').trim(); } catch { /* first start */ }
  const k = randomBytes(32).toString('hex');
  try { writeFileSync(path, k, { mode: 0o600, flag: 'wx' }); return k; } catch { return readFileSync(path, 'utf8').trim() || k; }
})();

// ---- retention: chats never linked to an email (nor a phone call to an order) 30 days after the last message, linked ones
// 12 months; sessions 30 days unused; rate-limit rows after a day; the ledger stays, with its IP hash blanked after 2
// days (the IP cap reads only today's).
const DAY_MS = 864e5;
export function sweep(t = now()) {
  // a phone call linked to an order by its code is kept as a chat linked to an email
  db.prepare('delete from conversations where email is null and linked is null and last < ?').run(t - 30 * DAY_MS);
  db.prepare('delete from conversations where (email is not null or linked is not null) and last < ?').run(t - 365 * DAY_MS);
  // a case (an email to a person, a question) keeps the customer's address and words: 12 months, like a thread; HQ's
  // card keeps its own copy under the same rule
  db.prepare('delete from cases where created < ?').run(t - 365 * DAY_MS);
  // a bug report (its case's one line on what went wrong, the picture and the log): until the bug is fixed (HQ says so,
  // hq.ts), and 90 days at most (the consent card says so); the bundle goes with its case (ON DELETE CASCADE)
  db.prepare("delete from cases where kind = 'bug' and created < ?").run(t - 90 * DAY_MS);
  db.prepare('delete from diagnostics where created < ?').run(t - 90 * DAY_MS);
  db.prepare('delete from sessions where seen < ?').run(t - 30 * DAY_MS);
  db.prepare('delete from hits where at < ?').run(t - DAY_MS);
  db.prepare('delete from actions where expires < ?').run(t - DAY_MS);
  db.prepare('delete from codes where created < ?').run(t - DAY_MS);
  db.prepare('delete from phone_codes where created < ?').run(t - DAY_MS);
  db.prepare('delete from nonces where used < ?').run(t - 8 * DAY_MS);
  db.prepare('delete from tool_log where at < ?').run(t - 7 * DAY_MS); // an eval run reads it within minutes
  db.prepare('delete from hq_wants where at < ?').run(t - 2 * DAY_MS); // HQ lists a want for an hour
  db.prepare('update ledger set ip = null where ip is not null and at < ?').run(t - 2 * DAY_MS);
  // counts name no one and could stay; a little over a year is enough to compare a month with last year's
  db.prepare('delete from tallies where day < ?').run(new Date(t - 400 * DAY_MS).toISOString().slice(0, 10));
  // a period ends at its end, or a cap's at its until when nothing closed it before (numbers.ts up() leaves an expired one)
  db.prepare('delete from downtime where coalesce(end, until) < ?').run(t - 400 * DAY_MS);
}

// ---- rate limits: true if this event is allowed (and counts it), false if `max` were already counted in the window
// (net(): shared/net/net.ts)
// Keys are an HMAC under the link key: a plain hash of an IPv4 address can be reversed by trying them all.
export const keyed = (key: string) => createHmac('sha256', linkKey).update(key).digest('hex');
// whether limit() would count one more now, counting nothing: for an event counted only once it has happened
export const underLimit = (key: string, max: number, windowMs: number, t = now()) =>
  (db.prepare('select count(*) as n from hits where key = ? and at > ?').get(keyed(key), t - windowMs) as any).n < max;
export function limit(key: string, max: number, windowMs: number, t = now()) {
  if (!underLimit(key, max, windowMs, t)) return false;
  db.prepare('insert into hits (key, at) values (?, ?)').run(keyed(key), t);
  return true;
}
