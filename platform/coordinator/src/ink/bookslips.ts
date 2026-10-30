// Answers on the book's notes (booknotes.ts has the notes and sheets) and on the notebook's groups:
//   - A note the judge says calls for an answer (bookjudge.ts) gets one within seconds from its owner's quick run
//     (bookanswer.ts answerNow), clipped on as a slip, wherever it was written (//     the judge, not a question mark).
//   - A slip: an agent's answer on a note (hq answer), with a picture or a preview's link if it has one. A tick closes
//     it; anything written under it is a reply, a new note on the owner's sheet, anchored where the note was.
//   - A slip can name an artifact (hq answer --artifact): what it made that runs, shown on the slip as artifacts.ts lists
//     it, its running preview and its cover, once it's there (merged and running). And "now": a cut of the note's place
//     from the live page, kept from before rule zero (HQ cut it while the note's hairline showed there; nothing of a
//     note is on a page now), beside the snip the board marked ("then").
//   - A slip clipped on, ticked or opened again is a 'book' event, so HQ reads the book again at once.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db, lacks, once, redacted, redactedJson } from '../db.ts'; // (lacks, once)
import { publish } from '../events.ts';
import { ceo } from '../company.ts';
import { findAgent, jobAgent, notePage } from '../jobs.ts';
import { keepFile } from '../uploads.ts';
import { BOARD } from './book.ts';
import { addNote, note, sheetRow, shown } from './booknotes.ts';
import { type Refused } from '../pagechecks.ts';
import { DIR, notFound, serveFile } from '../pagescraps.ts';
import * as artifacts from '../artifacts.ts';
import { whyMissed } from '../quickruns.ts';

export const SLIP_MAX = 4000,
  LINK_MAX = 500;
// An answer on a notebook group (grp, sent or not: note null while it isn't). job: the run that answered. ticked: when
// the board ticked it. artifact: the id of what it made that runs, as artifacts.ts lists it. now, now_at: the note's
// place cut again from the live page, its file and when. Its
// style ('text' | 'drawing' | 'form' | 'question' | 'version'), a version's two-word name and kept patch file, its ink
// (JSON ink.js strokes from its own top-left), a form (JSON questions.js questions) and the board's answers to it, its
// spot (JSON {dx, dy, w, h} from its group's box, answerspot.ts) and when the board picked it (a version). bookanswer.ts.
// source: where a picture's numbers came from (a chart). A version's branch (trybranch.ts branchVersion), when the board
// crossed it out, and when its branch and preview were cleared (bookpick.ts).
// base: the commit its branch was made on, which its preview serves with its patch (trypreview.ts.). branch_failed: why GitHub refused its branch (trybranch.ts.)
const SLIPS = `create table if not exists book_slips (id integer primary key autoincrement, note integer, by text not null,
  job integer, text text not null, picture text, link text, created text not null, ticked text, artifact text, now text,
  now_at text, grp integer, style text, version text, patch text, ink text, form text, form_answer text, spot text,
  picked text, source text, branch text, crossed text, cleared text, base text, branch_failed text)`;
db.exec(`${SLIPS}; create index if not exists book_slips_note on book_slips (note)`);
once('2026-10-26-book-slips-previews', () => {
  for (const column of ['artifact', 'now', 'now_at'])
    if (lacks('book_slips', column)) db.exec(`alter table book_slips add column ${column} text`);
});
// (an older database's: its note no longer required, the table made again with every row, and the answers' columns)
once('2026-10-28-book-slips-answers', () => {
  const columns = db.prepare('pragma table_info(book_slips)').all() as { name: string; notnull: number }[];
  if (columns.find(c => c.name === 'note')?.notnull) {
    const kept = columns.map(c => c.name).join(', ');
    db.exec(`alter table book_slips rename to book_slips_was; ${SLIPS};
      insert into book_slips (${kept}) select ${kept} from book_slips_was; drop table book_slips_was;
      create index if not exists book_slips_note on book_slips (note)`);
  }
  for (const column of ['grp integer', 'style text', 'version text', 'patch text', 'ink text', 'form text'])
    if (lacks('book_slips', column.split(' ')[0])) db.exec(`alter table book_slips add column ${column}`);
  for (const column of ['form_answer', 'spot', 'picked'])
    if (lacks('book_slips', column)) db.exec(`alter table book_slips add column ${column} text`);
});
once('2026-10-30-book-slips-versions', () => {
  for (const column of ['source', 'branch', 'crossed', 'cleared', 'base', 'branch_failed'])
    if (lacks('book_slips', column)) db.exec(`alter table book_slips add column ${column} text`);
});
db.exec('create index if not exists book_slips_grp on book_slips (grp)');
redacted('book_slips', 'text', 'link', 'version', 'source');
redactedJson('book_slips', 'form', 'form_answer');

export type Slip = {
  id: number;
  note: number | null;
  by: string;
  job: number | null;
  text: string;
  picture: string | null;
  link: string | null;
  created: string;
  ticked: string | null;
  artifact: string | null;
  now: string | null;
  now_at: string | null;
  grp: number | null;
  style: string | null;
  version: string | null;
  patch: string | null;
  ink: string | null;
  form: string | null;
  form_answer: string | null;
  spot: string | null;
  picked: string | null;
  source: string | null;
  branch: string | null;
  crossed: string | null;
  cleared: string | null;
  base: string | null;
  branch_failed: string | null;
};
// An artifact's id as artifacts.ts makes them: an app's slug, top/path for an artifact.yaml, a company artifact's open
// (an address, hence the colon).
export const ARTIFACT = /^[A-Za-z0-9._/:-]{1,200}$/;

// (a question now: the judge's quick run, bookanswer.ts answerNow)

// ---------------------------------------------------------------- slips
// POST /api/agent/answer (hq answer): bookanswer.ts answer (moved there, with an
// answer on a group, its ink, form, versions and who may answer)
// (more: an answer's picture, link and artifact, and the rest of an answer's,
// bookanswer.ts: its group, style, version, patch file, ink, form and spot as stored, JSON as JSON text)
type Stored = 'grp' | 'style' | 'version' | 'patch' | 'ink' | 'form' | 'spot' | 'source';
export type More = {
  picture?: { type: string; clean: Buffer } | null;
  link?: string | null;
  artifact?: string | null;
} & Partial<Record<Stored, string | number | null>>;
const STORED: Stored[] = ['grp', 'style', 'version', 'patch', 'ink', 'form', 'spot', 'source'];
export function addSlip(noteId: number | null, by: string, job: number | null, text: string, more: More = {}) {
  const id = Number(
    db
      .prepare(
        `insert into book_slips (note, by, job, text, link, artifact, created, ${STORED.join(', ')})
        values (?, ?, ?, ?, ?, ?, ?, ${STORED.map(() => '?').join(', ')})`,
      )
      .run(
        ...[noteId, by, job, text, more.link ?? null, more.artifact ?? null, new Date().toISOString()],
        ...STORED.map(k => more[k] ?? null),
      ).lastInsertRowid,
  );
  if (more.picture) {
    db.prepare('update book_slips set picture = ? where id = ?').run(keepPicture(`slip${id}`, more.picture), id);
  }
  publish({ type: 'log', agent: by, text: `An answer clipped onto a note in the board's book` });
  // (the page its note's group is on, read again)
  publish({ type: 'book', agent: by, text: 'slip', ...(noteId === null ? {} : notePage(noteId)) });
  return slipOf(db.prepare('select * from book_slips where id = ?').get(id) as Slip);
}
// A slip's picture kept as a file in the book's folder: its name.
export function keepPicture(name: string, picture: { type: string; clean: Buffer }) {
  const file = `${name}-${randomBytes(4).toString('hex')}.${picture.type === 'image/png' ? 'png' : 'jpg'}`;
  keepFile(`${DIR}/${file}`, picture.clean);
  return file;
}
// POST /api/book/slip/tick { id, ticked }: a tick closes the slip's note (false: open again)
export function tick(b: any, who = BOARD) {
  const slip = slipRow(Number(b?.id), who);
  if (!slip || slip.note === null) return 404; // (a group's, bookanswer.ts tick)
  if (typeof b.ticked !== 'boolean') return [400, 'ticked is true or false'] as Refused;
  db.prepare('update book_slips set ticked = ? where id = ?').run(b.ticked ? new Date().toISOString() : null, slip.id);
  const open = db.prepare('select 1 from book_slips where note = ? and ticked is null').get(slip.note);
  db.prepare(`update book_notes set status = ? where id = ? and status != 'open'`).run(
    open ? 'sent' : 'closed',
    slip.note,
  );
  publish({ type: 'book', agent: slip.by, text: 'slip', ...notePage(slip.note) });
  return { slip: slipOf(slipRow(slip.id, who)!), note: shown(note(slip.note)!) };
}
// POST /api/book/slip/reply { id, words, said? }: writing under a slip, a new note on the owner's open sheet, anchored
// where the note was (a question asks now)
export function replyTo(b: any, who = BOARD) {
  const slip = slipRow(Number(b?.id), who);
  if (!slip || slip.note === null) return 404;
  const n = note(slip.note)!,
    owner = sheetRow(n.sheet, null)!.owner;
  if (typeof b.words !== 'string' || !b.words.trim()) return [400, 'a reply has words'] as Refused;
  return addNote(
    { page: n.page, anchor: JSON.parse(n.anchor), words: b.words, said: b.said ?? 'written', to: owner },
    who,
    true,
    slip.id,
  );
}
// GET /api/book/slip/picture?id=<slip>, and GET /api/book/slip/now?id=<slip> (its "now": which)
export function serveSlipPicture(
  req: IncomingMessage,
  res: ServerResponse,
  who = BOARD,
  which: 'picture' | 'now' = 'picture',
) {
  const slip = slipRow(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('id')), who);
  const file = slip?.[which];
  if (!file || !existsSync(`${DIR}/${file}`)) return notFound(res);
  serveFile(res, file);
}

// A note's slips, as HQ reads them (listed: the artifacts as this read of the book lists them)
export const slipsOf = (note: number, listed = listedOnce()) =>
  (db.prepare('select * from book_slips where note = ? order by id').all(note) as Slip[]).map(s => slipOf(s, listed));
// The artifacts, listed once for a whole read of the book (its sheets, a page's notes, a note) and only once a slip names
// one: artifacts.ts walks the repository for them, on the coordinator's event loop.
export type Listed = () => artifacts.Artifact[];
export const listedOnce = (): Listed => {
  let listed: artifacts.Artifact[] | undefined;
  return () => (listed ??= artifacts.list());
};
// (an answer on a group is the group's page's person's; a wiped note's is
// nobody's until its Undo brings the note back)
export const slipRow = (id: number, who: string) => {
  const slip = db.prepare('select * from book_slips where id = ?').get(id) as Slip | undefined;
  if (!slip) return undefined;
  if (slip.note !== null) {
    const n = note(slip.note);
    return n && sheetRow(n.sheet, who) ? slip : undefined;
  }
  const mine = db
    .prepare('select 1 from notebook_groups g join book_pages p on p.id = g.page where g.id = ? and p.who = ?')
    .get(slip.grp, who);
  return mine ? slip : undefined;
};
// (preview, now, now_at; grp to picked, an answer's in a notebook)
export const slipOf = (s: Slip, listed = listedOnce()) => ({
  id: s.id,
  note: s.note,
  by: s.by,
  name: findAgent(s.by)?.name ?? s.by,
  text: s.text,
  picture: s.picture ? `/api/book/slip/picture?id=${s.id}` : null,
  link: s.link,
  preview: s.artifact ? previewOf(s.artifact, listed()) : null,
  now: s.now && s.now_at ? `/api/book/slip/now?id=${s.id}&v=${Date.parse(s.now_at).toString(36)}` : null,
  now_at: s.now ? s.now_at : null,
  created: s.created,
  ticked: s.ticked,
  grp: s.grp,
  face: null,
  style: s.style ?? 'text',
  ink: s.ink ? JSON.parse(s.ink) : null,
  form: s.form ? JSON.parse(s.form) : null,
  form_answer: s.form_answer ? JSON.parse(s.form_answer) : null,
  version: s.version,
  patch: !!s.patch,
  spot: s.spot ? JSON.parse(s.spot) : null,
  picked: s.picked,
  source: s.source,
  branch: s.branch,
  crossed: s.crossed,
  cleared: s.cleared,
  branch_failed: s.branch_failed,
});
// The artifact a slip names, as HQ shows it: its running preview (open) and cover (picture, HQ's address), or pending
// while it isn't listed yet (the work that answered is still in review, or not running).
function previewOf(id: string, listed: artifacts.Artifact[]) {
  const a = listed.find(x => x.id === id);
  return a ? { name: a.name, open: a.open, picture: a.picture } : { pending: true as const };
}

// ---------------------------------------------------------------- a notebook group's answers
// The answers on groups by their grp (sent or not), and a group's answer still
// coming: its quick run's (notebook_groups.asked, bookanswer.ts) at the spot it will take, while it goes and hasn't
// answered, and why none came once it has ended without one (until the thread moves on: bookanswer.ts movedOn).
export const answersOnGroups = (ids: number[], listed = listedOnce()) =>
  ids.length
    ? (
        db
          .prepare(`select * from book_slips where grp in (${ids.map(() => '?').join(', ')}) order by id`)
          .all(...ids) as Slip[]
      ).map(s => slipOf(s, listed))
    : [];
export const going = (job: number | null | undefined) =>
  !!job && !!db.prepare("select 1 from jobs where id = ? and status in ('queued', 'running')").get(job);
const byOf = (job: number) => {
  const by = jobAgent(job) ?? ceo();
  return { by, name: findAgent(by)?.name ?? by };
};
type Asking = { asked?: number | null; asked_spot?: string | null };
// The face a group shows for an answer not on it yet: the one coming, else why its ended ask brought none (quickruns.ts
// whyMissed)
export function waitingOf(g: Asking) {
  const coming = comingOf(g);
  if (coming) return coming;
  const asked = unanswered(g);
  return asked && whyMissed(asked) ? askedFace(g, asked) : null;
}
// An answer on its way: the group's quick run while it goes and hasn't answered (a try's versions coming are its try's:
// groupanswers.ts tryOf.)
export function comingOf(g: Asking) {
  const asked = unanswered(g);
  return asked && going(asked) ? askedFace(g, asked) : null;
}
// The group's ask, unless its run has clipped its answer
const unanswered = (g: Asking) =>
  g.asked && !db.prepare('select 1 from book_slips where job = ?').get(g.asked) ? g.asked : null;
// Who answers, at the spot the answer will take, with why it hasn't come where there's a reason
function askedFace(g: Asking, job: number) {
  const reason = whyMissed(job);
  return {
    ...byOf(job),
    spot: g.asked_spot ? JSON.parse(g.asked_spot) : null,
    style: 'text' as const,
    ...(reason && { reason }),
  };
}
