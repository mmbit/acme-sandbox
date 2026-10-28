// A try (Ink answers, DESIGN section 3): the judge (bookjudge.ts) reads a board's note as asking to see something made,
// so its owner makes a few versions of the real thing in a try run, and each lands on the note as a version.
//   - The try run is a jobs.ts job of kind 'try': it starts at once on a free work slot (never the chat slot), ahead of
//     the plan as the board's own word (expedite), in no thread, and commits nothing and opens no pull request (the
//     worker throws its clone away, as a meeting seat's): what it makes lives in the book.
//   - Its versions are answers on the note's root group (hq answer g<group> --version, bookanswer.ts), and they get a
//     page of their own right after the group's page in its notebook (book_pages.tries: the group), headed "<Agent>
//     tries: <words>". An old book's note (a call's page) has its versions page after its page (tries_note: the note),
//     which reads the note's versions (groupanswers.ts triedNoteOf), and a reply on one is a note there (notebooksend.ts
//     replyTo).
//   - One run per note at a time: a note written on the group or one of its versions while its try still runs goes to
//     that run (a message its hook hands the session at its next step; one not started yet takes it in its brief).
//   - On a call the run's the same; the call's agent writes text answers itself (answer_note: callanswer.ts), so onCall
//     tells the quick run's caller to leave the note to it.
import { readFileSync } from 'node:fs';
import { db, lacks } from '../db.ts';
import { ceo, companyDay } from '../company.ts';
import { createJob, findAgent } from '../jobs.ts';
import * as feedback from '../feedback.ts';
import { forRun } from '../messages.ts';
import { changed, pageRow } from '../notebook.ts';
import { row as groupRow, type Group } from '../notebookgroups.ts';
import { row as bookPage } from './book.ts';
import { note as noteRow, sheetRow, type Note } from './booknotes.ts';
import { keep } from './booksheets.ts';
import { heardOnCall } from './callanswer.ts';
import { LABEL_MAX, type Anchor } from '../pagechecks.ts';
import { DIR } from '../pagescraps.ts';
import { quotedPatch } from './bookpick.ts';

// book_notes.tried: the try run started for an old book's note, the latest (notebook_groups.tried, a group's, is
// notebookgroups.ts's; book_pages.tries and tries_note, a versions page's, notebook.ts's)
if (lacks('book_notes', 'tried')) db.exec('alter table book_notes add column tried integer');

export type Target = { grp?: number; note?: number };
// A run still going (or not started yet) takes a later note on the same note in; one that ended doesn't
const OPEN = "('queued', 'running')";

// ---------------------------------------------------------------- what a try is on
// The note a target stands for: its root group (the board's note itself, a reply's parent), or an old book's note
// (a call's page: no group) and the page it's on; reply: the target itself when it's a later note on it (its words,
// and the version it's under, if it is)
type Reply = { words: string; version: Version | null } | null;
type Version = { name: string; text: string; patch: string | null };
type Common = { page: number; words: string; owner: string; anchor: Anchor | null; reply: Reply };
type On = ({ kind: 'group'; root: Group } | { kind: 'note'; root: Note }) & Common;
function on(t: Target): On | null {
  const g = t.grp ? groupRow(t.grp) : t.note ? groupOfNote(t.note) : undefined;
  if (g) {
    const root = g.parent ? groupRow(g.parent) : g;
    const p = root && pageRow(root.page, null);
    if (!root || !p) return null;
    const words = root.words || g.words,
      reply = g.id === root.id ? null : { words: g.words, version: versionOf(g.answers) };
    const owner = root.owner ?? p.owner ?? ceo();
    return { kind: 'group', root, page: p.id, words, owner, anchor: anchorOf(root), reply };
  }
  const reply = t.note ? noteRow(t.note) : undefined;
  if (!reply) return null;
  // (a reply under a version or a slip: its note is the one the try is on)
  const answered = reply.answers
    ? (db.prepare('select note from book_slips where id = ?').get(reply.answers) as { note: number | null } | undefined)
    : undefined;
  const n = (answered?.note && noteRow(answered.note)) || reply;
  const p = bookPage(n.page, null);
  if (!p) return null;
  const owner = sheetRow(n.sheet, null)?.owner ?? p.owner ?? ceo(),
    later = n === reply ? null : { words: reply.words, version: versionOf(reply.answers) };
  const words = n.words || reply.words;
  return { kind: 'note', root: n, page: p.id, words, owner, anchor: JSON.parse(n.anchor), reply: later };
}
// The version a slip is, if it is one: its name, its line, and its patch as kept
function versionOf(slip: number | null): Version | null {
  const s =
    slip === null
      ? undefined
      : (db.prepare("select version, text, patch from book_slips where id = ? and style = 'version'").get(slip) as
          { version: string; text: string; patch: string | null } | undefined);
  if (!s) return null;
  return { name: s.version, text: s.text, patch: s.patch && readFileSync(`${DIR}/${s.patch}`, 'utf8') };
}
const groupOfNote = (note: number) =>
  db.prepare('select * from notebook_groups where note = ? and deleted is null').get(note) as Group | undefined;
const anchorOf = (g: Group) => (g.anchor ? (JSON.parse(g.anchor) as Anchor) : null);

// The try run on a group or note, if one is still open
const openTry = (o: On) =>
  db
    .prepare(
      `select j.id, j.status from ${o.kind === 'group' ? 'notebook_groups' : 'book_notes'} x join jobs j on j.id = x.tried
        where x.id = ? and j.status in ${OPEN}`,
    )
    .get(o.root.id) as { id: number; status: string } | undefined;

// Whether job `job` is the try run started for the group (its root's), or the note (note: true): it may answer it
// (bookanswer.ts, hq answer g<group>)
export function tryHolds(id: number, job: number, note = false) {
  const o = on(note ? { note: id } : { grp: id });
  if (!o || !job) return false;
  return (o.root as { tried?: number | null }).tried === job;
}

// The live call whose page a target is on, or null: there the call's agent answers in words itself (answer_note), so
// no quick run starts
export function onCall(t: Target): number | null {
  const o = on(t);
  const call = o && callOf(o.page);
  return call && db.prepare("select 1 from calls where id = ? and status = 'live'").get(call) ? call : null;
}
// The call a page is of (a call's notes page, in the book or My Notebook), live or ended, or null
const callOf = (page: number) => bookPage(page, null)?.call ?? null;

// ---------------------------------------------------------------- a try
// The judge's verdict 'try' on a board's note (bookjudge.ts): a note on a try still going goes to it; else its
// versions page, and a try run for its owner. Returns the run's job (null: nothing to try on).
export function tryNow(t: Target, verdict: { id: number; why: string }) {
  const o = on(t);
  if (!o) return null;
  const going = openTry(o);
  if (going) {
    toRun(going, o, t);
    return going.id;
  }
  const page = versionsPage(o);
  const kept = o.kind === 'note' ? keep(o.root, null) : null;
  const job = createJob({
    agent: o.owner,
    kind: 'try',
    title: `Versions for the board's note: ${oneLine(o.words) || 'a drawing'}`.slice(0, 140),
    prompt: tryBrief(o, page, verdict, kept?.id ?? null),
    queuedBy: 'hq',
    expedite: true,
    thread: null,
  }).id;
  if (kept) feedback.fromBook(kept.from, job);
  db.prepare(`update ${o.kind === 'group' ? 'notebook_groups' : 'book_notes'} set tried = ? where id = ?`).run(
    job,
    o.root.id,
  );
  heardOnCall(t); // (on a call, its agent hears the try has started)
  return job;
}

// A later note while the run goes: the session hears it at its next step; one not started yet takes it in its brief
function toRun(going: { id: number; status: string }, o: On, t: Target) {
  const later = t.grp ? groupRow(t.grp) : t.note ? noteRow(t.note) : undefined;
  const words = oneLine(later?.words ?? '') || '(ink only: `hq sketch` the page to see it)';
  const on = later && 'answers' in later && later.answers ? ` on version ${versionName(later.answers)}` : '';
  const line = `The board wrote again on the note you're trying${on}: “${words}”. Take it into the versions still to \
come, or make one more for it, clipped the same way.`;
  if (going.status === 'running') return forRun(o.owner, line, going.id);
  db.prepare("update jobs set prompt = prompt || ? where id = ? and status = 'queued'").run(`\n\n${line}`, going.id);
}
const versionName = (slip: number) => {
  const s = db.prepare('select * from book_slips where id = ?').get(slip) as { version?: string | null } | undefined;
  return s?.version ? `“${s.version}”` : `#${slip}`;
};

// The versions page: right after the note's page in its notebook (between it and the next), made once per note; an old
// book's page has no order but its day's, so it goes last in the day
function versionsPage(o: On) {
  const column = o.kind === 'group' ? 'tries' : 'tries_note';
  const found = db.prepare(`select id from book_pages where ${column} = ?`).get(o.root.id) as
    { id: number } | undefined;
  if (found) return found.id;
  const p = db.prepare('select who, notebook, pos from book_pages where id = ?').get(o.page) as {
    who: string;
    notebook: number | null;
    pos: number | null;
  };
  const next =
    p.notebook === null
      ? null
      : (
          db
            .prepare('select min(pos) pos from book_pages where notebook = ? and pos > ?')
            .get(p.notebook, p.pos ?? 0) as { pos: number | null }
        ).pos;
  const pos = p.notebook === null ? null : next === null ? (p.pos ?? 0) + 1 : ((p.pos ?? 0) + next) / 2;
  const now = new Date().toISOString(),
    name = findAgent(o.owner)?.name ?? o.owner;
  const whole = `${name} tries: ${oneLine(o.words) || 'a drawing'}`;
  const title = whole.length > LABEL_MAX ? `${whole.slice(0, LABEL_MAX - 1)}…` : whole;
  const id = Number(
    db
      .prepare(
        `insert into book_pages (who, day, kind, label, created, updated, w, h, notebook, pos, ${column})
          values (?, ?, 'free', ?, ?, ?, 1200, 1600, ?, ?, ?)`,
      )
      .run(p.who, companyDay(Date.now()), title, now, now, p.notebook, pos, o.root.id).lastInsertRowid,
  );
  if (p.notebook !== null) changed(p.notebook, id);
  return id;
}
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

// A later note the try is for: the board wrote on the note again, or on one of its versions, and the next versions
// start from that one
function replied({ words, version }: NonNullable<Reply>, page: number) {
  const said = `“${oneLine(words) || '(ink only: see it on the page)'}”`;
  if (!version)
    return `\nThe board wrote on it again: ${said}. That's what these versions answer, on top of the note.\n`;
  const patch = version.patch ? ` Its patch (start from it):\n${quotedPatch(version.patch)}` : '';
  return `\nThe board wrote on the version “${version.name}” (${version.text}; its frame is on page ${page}): \
${said}. The next versions start from that one and take what the board wrote into them.${patch}\n`;
}

// ---------------------------------------------------------------- the try run's brief
// (the board's screens when the note has no view of its own: desktop Chrome and the iPad mini, sideways)
const SCREENS = 'desktop Chrome at 1440 × 900, or the iPad mini at 1180 × 820';
function tryBrief(o: On, page: number, verdict: { why: string }, review: number | null) {
  const target = o.kind === 'group' ? `g${o.root.id}` : String(review);
  const view = o.anchor?.view;
  const screen = view ? `${Math.round(view.w)} × ${Math.round(view.h)} CSS px at ${view.dpr}x` : SCREENS;
  const where = o.anchor?.url ? `on HQ's page ${o.anchor.url}` : 'on a page of its notebook';
  const snip =
    o.kind === 'group'
      ? `\`hq sketch ${o.page}\` saves the page it's on as a picture (the note is group ${o.root.id} there)`
      : `\`hq note ${review}\` saves its snip (the page around the mark, the ink on it)`;
  return `The board wrote a note ${where}, in its book, and it asks to see it made: show it a few versions of the real \
thing, now. Why it reads as a try: ${verdict.why}

The note: “${oneLine(o.words) || '(ink only)'}”. ${snip}. Its versions go on a page of their own, right after the \
note's page (page ${page}), which the board sees filling in as you clip each one.
${o.reply ? replied(o.reply, page) : ''}
How:
- First say how many versions you'll make: \`hq answer ${target} --expect <n>\`. As many as are really different: \
often three, sometimes one bold alternative, never padding to fill a row.
- A version is the real thing changed, never a drawing of it: the page with the change made in your scratch copy of \
the repository, run and shot. For HQ: \`node platform/hq/serve.mjs\` serves it in dev mode with its mock data (an odd \
port; check it's listening first). For a product: its own preview. Something that doesn't exist yet (a new page, a \
new card) is built from scratch in the product's own look, in the same frame.
- Shoot it at the board's screen shape (${screen}), the note's place in frame, with Playwright.
- Clip each one as soon as it's done, not all at the end: \`hq answer ${target} "<one line on what's different>" \
--version "<two words>" --picture <png> --patch <file>\` (the patch: \`git diff\` of the change, kept with the frame so \
a pick's build starts from it).
- Versions that each take building go to helpers (team members) in parallel, one version each; you lead and clip.
- Never commit, push or open a pull request: your copy is thrown away when you end, and what you make lives in the \
book. Queue no work: the board picks a version by ringing or ticking it (you hear which), and the pick goes with \
its next send.
- Another note from the board on this one, while you're at it, reaches you as a message: take it in.
- End with one line: how many versions and what they try.`;
}
