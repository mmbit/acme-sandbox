// Links to other companies' HQs, and the entries that carry the workspaces they share (workspaces.ts) between them. The
// board invites a company or accepts its invitation in Settings › Companies, and either side unlinks there. Each side
// makes the key the other calls it with and keeps it by its hash alone; the key it calls the other with sits in its key
// store (secrets.ts LINK_KEY), never in text. Our entries go to the other HQ in order, at once and every minute until it
// takes them; theirs are applied here in order, each once. The design: platform/coordinator/docs/companies.md.
import { createHash, randomBytes } from 'node:crypto';
import { ORIGIN } from './config.ts';
import { afterStep, db, inOneStep } from './db.ts';
import { brand } from './companyfiles.ts';
import * as linklog from './linklog.ts';
import * as secrets from './secrets.ts';
import * as files from './workspacefiles.ts';

// invited: an invitation of ours not used yet; joining: our accept of theirs, while their HQ answers
type LinkState = 'invited' | 'joining' | 'linked' | 'unlinked';
export type LinkRow = {
  id: number;
  state: LinkState;
  name: string | null;
  address: string | null;
  made: string;
  linked: string | null;
  unlinked: string | null;
  unlinked_by: 'us' | 'them' | null;
  sent: number;
  received: number;
  reached: string | null;
  heard: string | null;
  refused: string | null;
};
// A refusal in words, with its status, as the routes answer it (server.ts refusal)
type Refusal = [number, string];

// sent: the highest of our entries their HQ took; received: the highest of theirs applied here; reached and heard: when
// those last moved; refused: their HQ's last refusal of a push, until one goes through.
db.exec(`create table if not exists links (id integer primary key, state text not null, invitation_hash text unique,
  name text, address text, key_hash text unique, made text not null, linked text, unlinked text, unlinked_by text,
  sent integer not null default 0, received integer not null default 0, reached text, heard text, refused text)`);

// A push holds this much JSON at most, so neither HQ reads more than this into memory at once; an entry bigger than
// this (a file near workspaces.ts FILE_MAX_BYTES) goes alone.
const PUSH_BYTES = 16 * 1024 * 1024;
// The other HQ's answer to an accept, a push or an unlink: past this, it counts as unreachable and the next minute tries
const CALL_MS = 30_000;
const NAME_MAX_CHARS = 60;
const KEY = /^link_[A-Za-z0-9_-]{43}$/;
const INVITATION = /^invite_[A-Za-z0-9_-]{43}$/;
export const NOT_ONE_LINE = /[\p{C}\p{Zl}\p{Zp}]/gu; // what a name or title of theirs loses to stay one line

// ---- the board's

export function listLinks() {
  const links = db
    .prepare("select * from links where state in ('linked', 'unlinked') order by state = 'unlinked', linked desc")
    .all() as LinkRow[];
  const invitations = db.prepare("select id, made from links where state = 'invited' order by id").all();
  return { name: ourName(), address: ORIGIN, links: links.map(shown), invitations };
}

// A new invitation, which the board's answer shows once and HQ keeps by its hash alone
export function invite() {
  const token = `invite_${randomBytes(32).toString('base64url')}`;
  const { id } = db
    .prepare("insert into links (state, invitation_hash, made) values ('invited', ?, ?) returning id")
    .get(hashOf(token), now()) as { id: number };
  return { id, invitation: `${ORIGIN}#${token}` };
}

export function withdraw(id: number): Refusal | { ok: true } {
  const { changes } = db.prepare("delete from links where id = ? and state = 'invited'").run(id);
  return changes ? { ok: true } : [404, "There's no such open invitation."];
}

// The other company's invitation, pasted by our board: their HQ takes the key it will call us with and answers with
// its name and the key we call it with.
export async function join(given: unknown): Promise<Refusal | { link: ReturnType<typeof shown> }> {
  const invitation = invitationOf(given);
  if (!invitation)
    return [400, 'An invitation is the whole line the other company’s HQ showed, from https:// to the end.'];
  const { address, token } = invitation;
  if (address === ORIGIN) return [400, 'This is our own invitation: it goes to the other company’s board.'];
  if (linkedTo(address)) return [409, `We're linked to ${address} already.`];
  const key = `link_${randomBytes(32).toString('base64url')}`;
  const { id } = db
    .prepare("insert into links (state, address, key_hash, made) values ('joining', ?, ?, ?) returning id")
    .get(address, hashOf(key), now()) as { id: number };
  const answer = await call(address, '/api/peer/accept', null, {
    invitation: token,
    name: ourName(),
    address: ORIGIN,
    key,
  });
  const name = nameOf(answer.body?.name),
    theirKey = String(answer.body?.key);
  if (answer.status !== 200 || !name || !KEY.test(theirKey)) {
    db.prepare('delete from links where id = ?').run(id);
    return [
      502,
      `${address} didn't take the invitation: ${answer.status === 200 ? 'its answer is not one this HQ reads' : answer.error}.`,
    ];
  }
  secrets.keepMadeKey(keyName(id), theirKey);
  db.prepare("update links set state = 'linked', name = ?, linked = ? where id = ?").run(name, now(), id);
  return { link: shown(findLink(id)!) };
}

// Either side unlinks: the keys go at once, and the other HQ is told. One that's down hears it at its next push (410).
// Both keep what was shared up to now, and nothing more crosses.
export async function unlink(id: number): Promise<Refusal | { link: ReturnType<typeof shown> }> {
  const link = findLink(id);
  if (link?.state !== 'linked') return [404, "There's no such linked company."];
  const key = secrets.secret(keyName(id));
  markUnlinked(id, 'us');
  const told = await call(link.address!, '/api/peer/unlink', key, {});
  if (told.status !== 200) console.log(`Link #${id}: unlinked, ${link.address} not told: ${told.error}`);
  return { link: shown(findLink(id)!) };
}

// ---- the other company's HQ (the peer routes, server.ts)

// Their HQ accepting our invitation: it names itself, its address and the key we call it with.
export function accept(body: Record<string, unknown>): Refusal | { name: string; key: string } {
  const invited = db
    .prepare("select id from links where state = 'invited' and invitation_hash = ?")
    .get(hashOf(String(body.invitation ?? ''))) as { id: number } | undefined;
  if (!invited) return [403, 'This invitation was used or withdrawn, or is not ours.'];
  const name = nameOf(body.name),
    address = addressOf(body.address);
  if (!name || !address || !KEY.test(String(body.key)))
    return [400, 'An accept gives its company’s name, its HQ’s address and the key we call it with.'];
  if (linkedTo(address)) return [409, 'We are linked to this HQ already.'];
  const key = `link_${randomBytes(32).toString('base64url')}`;
  secrets.keepMadeKey(keyName(invited.id), String(body.key));
  db.prepare(
    "update links set state = 'linked', invitation_hash = null, name = ?, address = ?, key_hash = ?, linked = ? where id = ?",
  ).run(name, address, hashOf(key), now(), invited.id);
  return { name: ourName(), key };
}

// The link a caller's key opens: a linked one, 410 for one unlinked since (so its side unlinks too), 401 for any other
export function peerOf(authorization: string | undefined): LinkRow | number {
  const key = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
  const link = key
    ? (db.prepare('select * from links where key_hash = ?').get(hashOf(key)) as LinkRow | undefined)
    : undefined;
  if (!link || link.state === 'joining') return 401;
  return link.state === 'linked' ? link : 410;
}

export function peerUnlinked(link: LinkRow) {
  markUnlinked(link.id, 'them');
  return { ok: true };
}

// An entry of theirs that can't be applied: the whole push is refused with why
export class EntryError extends Error {}

// A push of their entries, applied in one step or not at all, to the link as the step reads it (410 once unlinked: it
// can change while the body comes). Each applies once, in order: one we hold already is skipped, and a gap ends the
// push there (they send the rest again). Its answer is the highest entry we hold, and the kinds we take (their HQ holds
// back any other, linklog.ts).
export function receive(peer: LinkRow, body: Record<string, unknown>, applier: Applier) {
  const pushed = body.entries;
  if (!Array.isArray(pushed)) return [400, 'A push is { entries: [...] }.'] as Refusal;
  try {
    return inOneStep(() => {
      const link = findLink(peer.id)!;
      if (link.state !== 'linked') return [410, 'unlinked'] as Refusal;
      let received = link.received;
      for (const entry of pushed as Entry[]) {
        if (!Number.isSafeInteger(entry?.seq)) throw new EntryError('every entry has its number, seq');
        if (entry.seq <= received) continue;
        if (entry.seq !== received + 1) break;
        applier.apply(link, entry);
        received = entry.seq;
      }
      db.prepare('update links set received = ?, heard = ? where id = ?').run(received, now(), link.id);
      return { received, takes: applier.TAKES };
    });
  } catch (err) {
    if (err instanceof EntryError) return [400, `Refused: ${err.message}.`] as Refusal;
    throw err;
  }
}

// ---- our entries, and pushing them

export type Entry = linklog.Entry;
// The kinds of entry we apply, and how (workspaceentries.ts)
type Applier = { apply: (link: LinkRow, entry: Entry) => void; TAKES: string[] };

// Adds an entry to the link's log, pushed once the step it's in is kept. Its number, for the row that made it, or null
// while it waits for their HQ to take its kind (linklog.ts).
export function record(link: number, body: linklog.EntryBody) {
  const seq = linklog.add(link, body);
  afterStep(() => void push(link));
  return seq;
}

const pushing = new Set<number>();
// Our entries their HQ hasn't taken, in order, in pushes of at most PUSH_BYTES, until it has them all or refuses. With
// none waiting but some held, one push of none asks it what it takes now.
export async function push(id: number) {
  if (pushing.has(id)) return;
  pushing.add(id);
  try {
    let asks = linklog.holds(id);
    for (
      let link = findLink(id);
      link?.state === 'linked' && (asks || waitingOf(link).count > 0);
      link = findLink(id)
    ) {
      asks = false;
      const entries = linklog.batchOf(id, link.sent, PUSH_BYTES);
      const answer = await call(link.address!, '/api/peer/entries', secrets.secret(keyName(id)), { entries });
      if (answer.status === 410) return markUnlinked(id, 'them');
      const received = Number(answer.body?.received),
        last = entries.at(-1)?.seq ?? link.sent;
      // (one past our last: an HQ that says it holds more of ours than it was sent, a rewound log of ours or a wrong one)
      const refused =
        answer.status !== 200 || !Number.isSafeInteger(received)
          ? answer.error
          : received > last && `that it holds our entry ${received}, past our last, ${last}`;
      if (refused) {
        db.prepare('update links set refused = ? where id = ?').run(refused, id);
        return;
      }
      tookUpTo(id, received);
      linklog.heard(id, answer.body?.takes);
      if (received < last) return;
    }
  } finally {
    pushing.delete(id);
  }
}

// Each minute (server.ts): every link with entries still waiting, or held for its HQ
export async function sweep() {
  const linked = db.prepare("select * from links where state = 'linked'").all() as LinkRow[];
  for (const link of linked) if (waitingOf(link).count > 0 || linklog.holds(link.id)) await push(link.id);
}

// What the CEO's summary says of the links (summary.ts): a company whose HQ hasn't taken our entries for longer than a
// few missed pushes, and one that unlinked us after `since`
const STALLED_MS = 10 * 60_000;
export function summaryLines(now: number, since: string) {
  const linked = db.prepare("select * from links where state = 'linked' order by id").all() as LinkRow[];
  const stalled = linked
    .map(link => ({ link, waiting: waitingOf(link) }))
    .filter(({ waiting }) => waiting.since !== null && now - Date.parse(waiting.since) > STALLED_MS)
    .map(
      ({ link, waiting }) =>
        `${link.name}'s HQ hasn't taken our entries since ${minute(waiting.since!)} UTC (${waiting.count} waiting` +
        `${link.refused ? `, it answered ${link.refused}` : ', unreachable'}): our side goes on, they go when it's back`,
    );
  const unlinked = db
    .prepare("select * from links where state = 'unlinked' and unlinked_by = 'them' and unlinked > ? order by id")
    .all(since) as LinkRow[];
  return [
    ...stalled,
    ...unlinked.map(
      l =>
        `${l.name} unlinked us at ${minute(l.unlinked!)} UTC: our workspaces with them stay readable, nothing more crosses`,
    ),
  ];
}

export const findLink = (id: number) => db.prepare('select * from links where id = ?').get(id) as LinkRow | undefined;

export const ourName = () => String(brand().name ?? '');

function tookUpTo(id: number, received: number) {
  const at = now();
  inOneStep(() => {
    linklog.tookUpTo(id, received, at);
    db.prepare('update links set sent = max(sent, ?), reached = ?, refused = null where id = ?').run(received, at, id);
    files.clearOld(); // (a version of ours that waited for their HQ to take it.)
  });
}

const waitingOf = (link: LinkRow) => linklog.waitingOf(link.id, link.sent);

function markUnlinked(id: number, by: 'us' | 'them') {
  db.prepare(
    "update links set state = 'unlinked', unlinked = ?, unlinked_by = ? where id = ? and state = 'linked'",
  ).run(now(), by, id);
  secrets.forget([keyName(id)]);
}

// A link as the board's and the agents' routes show it
function shown(link: LinkRow) {
  const waiting = waitingOf(link);
  return {
    id: link.id,
    name: link.name,
    address: link.address,
    state: link.state,
    linked: link.linked,
    unlinked: link.unlinked,
    unlinkedBy: link.unlinked_by,
    reached: link.reached,
    heard: link.heard,
    refused: link.refused,
    waiting: link.state === 'linked' ? waiting.count : 0,
    waitingSince: link.state === 'linked' ? waiting.since : null,
  };
}
export type ShownLink = ReturnType<typeof shown>;

// The other HQ's answer, or its failure in words (status 0: unreachable)
async function call(address: string, path: string, key: string | null, body: unknown) {
  try {
    const res = await fetch(address + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      redirect: 'manual', // (answered, never followed: what's sent goes to the link's own address alone)
      signal: AbortSignal.timeout(CALL_MS),
    });
    const answer = (await res.json().catch(() => null)) as Record<string, any> | null;
    return {
      status: res.status,
      body: answer,
      error: `${res.status} ${String(answer?.error ?? answer?.reason ?? res.statusText)}`,
    };
  } catch (err) {
    return { status: 0, body: null, error: `unreachable (${(err as Error).cause ?? (err as Error).message})` };
  }
}

function invitationOf(given: unknown) {
  try {
    const url = new URL(String(given ?? '').trim());
    const token = url.hash.slice(1);
    const address = addressOf(url.origin);
    return address && INVITATION.test(token) ? { address, token } : null;
  } catch {
    return null;
  }
}

// An HQ's address: https, or, when we run on this machine ourselves (a test's HQ, or one run locally), http on it too
function addressOf(given: unknown) {
  try {
    const url = new URL(String(given));
    const local = url.protocol === 'http:' && url.hostname === 'localhost' && ORIGIN.startsWith('http://localhost:');
    return url.protocol === 'https:' || local ? url.origin : null;
  } catch {
    return null;
  }
}

function nameOf(given: unknown) {
  const name = typeof given === 'string' ? given.replace(NOT_ONE_LINE, '').trim() : '';
  return name && name.length <= NAME_MAX_CHARS ? name : null;
}

const linkedTo = (address: string) =>
  !!db.prepare("select 1 from links where address = ? and state = 'linked'").get(address);
const keyName = (id: number) => `LINK_${id}_KEY`;
const hashOf = (key: string) => createHash('sha256').update(key).digest('hex');
const now = () => new Date().toISOString();
const minute = (iso: string) => iso.slice(0, 16).replace('T', ' ');
