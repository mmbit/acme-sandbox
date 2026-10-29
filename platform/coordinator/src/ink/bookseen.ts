// What the book's judge (bookjudge.ts) reads of a note.
import { readFileSync, existsSync } from 'node:fs';
import { db } from '../db.ts';
import { ORIGIN } from '../config.ts';
import { findAgent } from '../jobs.ts';
import { DIR } from '../pagescraps.ts';
import type { Target } from './bookjudge.ts';

// What the judge reads of a target: whose, its words, when they were saved and how they came, its picture, its page,
// and the answer it replies to
export type Seen = {
  by: string;
  words: string;
  saved: string;
  said: string | null;
  picture: { type: string; data: Buffer } | null;
  where: string;
  answers: number | null; // (the answer it replies to: a book_slips row)
};
type PageRow = { id: number; kind: string; owner: string | null; url: string | null; call: number | null };
const pageOf = (id: number) =>
  db.prepare('select id, kind, owner, url, call from book_pages where id = ?').get(id) as PageRow | undefined;
const nameOf = (agent: string | null) => (agent ? (findAgent(agent)?.name ?? agent) : null);
// (a version says which of its set it is, and its name)
export const slipText = (id: number | null) => {
  const s =
    id &&
    (db.prepare('select text, style, version, grp, note from book_slips where id = ?').get(id) as
      | { text: string; style: string | null; version: string | null; grp: number | null; note: number | null }
      | undefined);
  if (!s) return null;
  if (s.style !== 'version') return s.text;
  const set = (
    db
      .prepare(
        "select id from book_slips where style = 'version' and ((grp is not null and grp = ?) or (note is not null and note = ?)) order by id",
      )
      .all(s.grp, s.note) as { id: number }[]
  ).map(x => x.id);
  return `version ${set.indexOf(id as number) + 1} of ${set.length}, “${s.version ?? ''}”, one of a few the agent made for the board to choose from: ${s.text}`;
};
export const isVersion = (id: number | null) =>
  !!id && !!db.prepare("select 1 from book_slips where id = ? and style = 'version'").get(id);

// (picture false: only the words, to check they're still the ones judged)
export async function seenOf(t: Target, picture = true): Promise<Seen | null> {
  if (t.grp) return groupSeen(t.grp, picture);
  if (t.note) return noteSeen(t.note, picture);
  if (t.page && t.text !== undefined) return boxSeen(t.page, t.text);
  return null;
}
async function groupSeen(id: number, picture: boolean): Promise<Seen | null> {
  const g = db.prepare('select * from notebook_groups where id = ? and deleted is null').get(id) as
    | {
        id: number;
        page: number;
        parent: number | null;
        answers: number | null;
        kind: string;
        by: string;
        texts: string;
        anchor: string | null;
        words: string;
        said: string | null;
        owner: string | null;
        updated: string;
      }
    | undefined;
  const p = g && pageOf(g.page);
  if (!g || !p) return null;
  const typed = (JSON.parse(g.texts) as { text: string }[]).map(x => x.text).join('\n');
  const words = g.words || typed,
    said = g.words ? g.said : typed ? 'typed' : null;
  let pic: Seen['picture'] = null;
  // (a reply: its note's picture, the answer's frame under the ink when it's on a version.)
  const sent = picture && g.kind === 'reply' && noteSnip(g.id);
  if (sent) pic = sent;
  else if (picture) {
    const { snipOf } = await import('../notebooksend.ts');
    const drawn = await snipOf(g as never);
    pic = drawn && { type: drawn.type, data: drawn.clean };
  }
  const anchor = g.anchor ? (JSON.parse(g.anchor) as { url?: string }) : null;
  const where =
    g.kind === 'scrap' && anchor?.url
      ? `a scrap the board cut from ${pageWhere(anchor.url, g.owner)}, kept on a page of its notebook`
      : p.kind === 'call'
        ? callWhere(p)
        : g.kind === 'reply'
          ? 'under an answer on a page of its notebook'
          : 'drawn on a free page of its notebook';
  return { by: g.by, words, saved: g.updated, said, picture: pic, where, answers: g.answers };
}
function noteSnip(grp: number) {
  const n = db
    .prepare('select n.snip from book_notes n join notebook_groups g on g.note = n.id where g.id = ?')
    .get(grp) as { snip: string | null } | undefined;
  const file = n?.snip ? `${DIR}/${n.snip}` : null;
  return file && existsSync(file)
    ? { type: file.endsWith('.png') ? 'image/png' : 'image/jpeg', data: readFileSync(file) }
    : null;
}
async function noteSeen(id: number, picture: boolean): Promise<Seen | null> {
  const n = db.prepare('select * from book_notes where id = ?').get(id) as
    | {
        page: number;
        by: string;
        anchor: string;
        words: string;
        said: string | null;
        snip: string | null;
        answers: number | null;
        updated: string;
      }
    | undefined;
  const p = n && pageOf(n.page);
  if (!n || !p) return null;
  const file = picture && n.snip ? `${DIR}/${n.snip}` : null;
  const pic =
    file && existsSync(file)
      ? { type: file.endsWith('.png') ? 'image/png' : 'image/jpeg', data: readFileSync(file) }
      : null;
  const url = (JSON.parse(n.anchor) as { url?: string }).url ?? p.url;
  const where =
    p.kind === 'call' ? callWhere(p) : p.kind === 'free' || !url ? 'a free page of its book' : pageWhere(url, p.owner);
  return { by: n.by, words: n.words, saved: n.updated, said: n.said, picture: pic, where, answers: n.answers };
}
function boxSeen(page: number, text: string): Seen | null {
  const p = db.prepare('select id, kind, owner, url, call, who, updated from book_pages where id = ?').get(page) as
    (PageRow & { who: string; updated: string }) | undefined;
  if (!p) return null;
  const where = p.kind === 'call' ? callWhere(p) : p.url ? pageWhere(p.url, p.owner) : 'a free page of its book';
  return {
    by: p.who,
    words: text,
    saved: p.updated,
    said: 'typed',
    picture: null,
    where: `a box typed on ${where}`,
    answers: null,
  };
}
// HQ's own page (its path) or an app's address, and whose work it is
function pageWhere(url: string, owner: string | null) {
  const own = nameOf(owner),
    hq = url.startsWith('/') || url.startsWith(ORIGIN);
  const at = hq ? `HQ's page ${url.slice(url.startsWith(ORIGIN) ? ORIGIN.length : 0) || '/'}` : `the page ${url}`;
  return own ? `${at} (${own}'s work)` : at;
}
function callWhere(p: PageRow) {
  const agent = (db.prepare('select agent from calls where id = ?').get(p.call) as { agent: string } | undefined)
    ?.agent;
  return `the page of a call with ${nameOf(agent ?? null) ?? 'an agent'}, during the call`;
}
