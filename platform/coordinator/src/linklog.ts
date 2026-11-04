// Our log of entries for each link (links.ts pushes it): what we recorded for the other HQ, numbered from 1, and when it
// took each. An entry of a kind their HQ hasn't said it takes waits apart, unnumbered, and joins the log once it does.
import { db, inOneStep } from './db.ts';
import * as files from './workspacefiles.ts';

// Each entry as JSON (a file's without its bytes, workspacefiles.ts), and when their HQ took it
db.exec(`create table if not exists link_entries (link integer not null, seq integer not null, body text not null,
  at text not null, taken text, primary key (link, seq))`);
// Entries of a kind their HQ doesn't take yet, in the order recorded; and the kinds it said it takes at its last answer
db.exec(
  'create table if not exists link_held (id integer primary key, link integer not null, body text not null, at text not null)',
);
db.exec('create table if not exists link_kinds (link integer primary key, takes text not null)');

// What every HQ on the foundation takes, whether its answers say so or not: an older HQ refuses any other kind, and
// with it the whole push, so another kind waits until their HQ names it
const FIRST_KINDS = ['workspace', 'thread', 'message', 'file', 'read'];

// What one side tells the other: kind and its fields (workspaces.ts), and its number in the sender's log
export type EntryBody = { kind: string; [field: string]: unknown };
export type Entry = EntryBody & { seq: number };

// Adds an entry to the link's log: its number, or null while it waits for their HQ to take its kind
export function add(link: number, body: EntryBody) {
  if (!takesOf(link).includes(body.kind)) {
    db.prepare('insert into link_held (link, body, at) values (?, ?, ?)').run(link, JSON.stringify(body), now());
    return null;
  }
  const { seq } = db.prepare('select coalesce(max(seq), 0) + 1 seq from link_entries where link = ?').get(link) as {
    seq: number;
  };
  db.prepare('insert into link_entries (link, seq, body, at) values (?, ?, ?, ?)').run(
    link,
    seq,
    JSON.stringify(body),
    now(),
  );
  return seq;
}

// Their HQ's answer named the kinds it takes (an older one names none): the entries held for them join the log, in
// order
export function heard(link: number, takes: unknown) {
  const kinds = Array.isArray(takes) ? takes.filter(kind => typeof kind === 'string') : FIRST_KINDS;
  inOneStep(() => {
    db.prepare('insert or replace into link_kinds (link, takes) values (?, ?)').run(link, JSON.stringify(kinds));
    const held = db.prepare('select id, body from link_held where link = ? order by id').all(link) as {
      id: number;
      body: string;
    }[];
    const going = held.filter(h => kinds.includes((JSON.parse(h.body) as EntryBody).kind));
    for (const h of going) {
      db.prepare('delete from link_held where id = ?').run(h.id);
      add(link, JSON.parse(h.body) as EntryBody);
    }
  });
}

export const holds = (link: number) => !!db.prepare('select 1 from link_held where link = ?').get(link);

// When their HQ took entry `seq` of ours, or null while it's on its way
export function takenAt(link: number, seq: number | null) {
  const row =
    seq === null ? undefined : db.prepare('select taken from link_entries where link = ? and seq = ?').get(link, seq);
  return (row as { taken: string | null } | undefined)?.taken ?? null;
}

// The entries after `sent`, in order, up to `maxBytes` of JSON (one at least), each file's with its bytes
export function batchOf(link: number, sent: number, maxBytes: number) {
  const rows = db
    .prepare('select seq, body from link_entries where link = ? and seq > ? order by seq')
    .iterate(link, sent) as Iterable<{ seq: number; body: string }>;
  const entries: Entry[] = [];
  let bytes = 0;
  for (const row of rows) {
    const body = JSON.parse(row.body) as EntryBody;
    const entry: Entry = {
      ...body,
      seq: row.seq,
      ...(body.kind === 'file' ? { data: files.read(String(body.sha256)).toString('base64') } : {}),
    };
    bytes += JSON.stringify(entry).length;
    if (entries.length && bytes > maxBytes) break;
    entries.push(entry);
  }
  return entries;
}

export const tookUpTo = (link: number, received: number, at: string) =>
  db.prepare('update link_entries set taken = ? where link = ? and seq <= ? and taken is null').run(at, link, received);

export const waitingOf = (link: number, sent: number) =>
  db.prepare('select count(*) count, min(at) since from link_entries where link = ? and seq > ?').get(link, sent) as {
    count: number;
    since: string | null;
  };

const takesOf = (link: number) => {
  const row = db.prepare('select takes from link_kinds where link = ?').get(link) as { takes: string } | undefined;
  return row ? (JSON.parse(row.takes) as string[]) : FIRST_KINDS;
};
const now = () => new Date().toISOString();
