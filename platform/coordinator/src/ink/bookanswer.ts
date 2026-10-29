// An agent's answer on the board's notebook: on a group (sent or not, `grp`) or on a note (the old book's, or the one a
// group went as). The judge (bookjudge.ts) asks for one when a note calls for words: answerNow starts the owner's quick
// run (chat.ts), and while it goes the group shows the owner's face and pencil dots at the spot the answer will take.
// What an answer holds is its style: 'text' (words, a picture or a preview's link), 'drawing' (ink), 'form' (questions,
// questions.js's, the board fills in), 'question' (the agent asks the board), 'version' (a try run's frame of the thing
// changed, with its patch: booktry.ts). It lies where the paper is free (answerspot.ts), never over the board's groups,
// and keeps that spot. The board ticks it (a version: picks it), writes a reply under it (notebooksend.ts replyTo) or
// answers its form; the open list is the forms and questions still waiting on the board.
//   - Every change is a 'book' event with text 'notebook' and the page (notebook.ts changed).
import { randomBytes } from 'node:crypto';
import { db, inOneStep, lacks } from '../db.ts';
import { publish } from '../events.ts';
import { ceo } from '../company.ts';
import { findAgent, jobAgent, notePage, type Reader } from '../jobs.ts';
import * as feedback from '../feedback.ts';
import { onQuickRun, quickRun } from '../quickruns.ts';
import { keepFile } from '../uploads.ts';
import * as asking from '../../../hq/shell/questions.js';
import { BOARD } from './book.ts';
import { note, sheetRow, shown, type Note } from './booknotes.ts';
import { keep } from './booksheets.ts';
import { SLIP_MAX, addSlip, slipOf, slipRow, type More, type Slip } from './bookslips.ts';
import { type Contents, type Spot } from './answerspot.ts';
import { placeFor, QUICK_WORDS } from './answerplace.ts';
import { onCall, tryHolds } from './booktry.ts';
import { pick } from './bookpick.ts';
import { partsOfAnswer } from './answerparts.ts';
import { isRefused, type Refused } from '../pagechecks.ts';
import { DIR } from '../pagescraps.ts';
import { changed, pageRow, triesPageOfNote } from '../notebook.ts';
import { groupOfNote, groupOn, partsOf, rootOf, row, type Group } from '../notebookgroups.ts';
import { boxOf } from '../notebookparts.ts';
import { anchorOf, replyNote } from '../notebooksend.ts';

export type Target = { grp?: number; note?: number };
// The versions a try may say it makes
const EXPECT_MAX = 12;
// book_notes.reason: the slip saying why an old book's note got no answer, while it's shown (noAnswer; a group's is
// notebookgroups.ts's)
if (lacks('book_notes', 'reason')) db.exec('alter table book_notes add column reason integer');

// A call's agent hears what's new on a note on its live call (callanswer.ts: imported when it's needed, as bookjudge.ts
// does this file, for the cycle through the judge)
const heardOnCall = (t: Target) => void import('./callanswer.ts').then(m => m.heardOnCall(t));

// ---------------------------------------------------------------- the quick run
// The owner's quick run for a verdict 'answer' (ownerOf). Not on a call: there the call's agent answers itself
// (booktry.ts onCall).
const PURPOSE = 'ink-answer';
export function answerNow(t: Target, verdict: { id: number; why: string }) {
  if (onCall(t) !== null) {
    heardOnCall(t); // (the call's agent hears it calls for an answer: it writes it itself)
    return null;
  }
  const agent = ownerOf(t);
  if (agent === null) return null;
  forgetReason(t);
  if (t.grp !== undefined) {
    const g = row(t.grp)!,
      top = rootOf(g),
      p = pageRow(top.page, null)!;
    const spot = placeFor(top, { text: QUICK_WORDS }, null, null);
    const job = quickRun(agent, 'A note in the board’s notebook', groupBrief(g, top, p.id, verdict.why), PURPOSE);
    movedOn(top);
    db.prepare('update notebook_groups set asked = ?, asked_spot = ? where id = ?').run(
      job,
      JSON.stringify(spot),
      g.id,
    );
    changed(p.notebook, p.id);
    return job;
  }
  const n = note(t.note!)!,
    kept = keep(n, null);
  const job = quickRun(agent, 'A note in the board’s book', noteBrief(kept.id, kept.text, verdict.why), PURPOSE);
  feedback.fromBook(kept.from, job);
  db.prepare('update book_notes set asked = ? where id = ?').run(job, n.id);
  return job;
}
// Who answers a target: a group's scrap's owner, else its page's, else the CEO; a note's sheet's owner, else the CEO
// (null: the group deleted or the note gone)
function ownerOf(t: Target) {
  if (t.grp !== undefined) {
    const g = row(t.grp),
      top = g && rootOf(g),
      p = top && pageRow(top.page, null);
    return g && top && p && g.deleted === null ? (top.owner ?? p.owner ?? ceo()) : null;
  }
  const n = t.note === undefined ? undefined : note(t.note);
  return n ? (sheetRow(n.sheet, null)?.owner ?? ceo()) : null;
}
const ANSWER_FIRST = `Answer it now: your final message is the answer, exactly as the board reads it, written in beside \
its note. Plain words, the answer first, about 60 words. If it needs work rather than an answer, say what you'd do: the \
board sends it. Don't queue work or change files.`;
const RICHER = (target: string) => `If words aren't the best answer, clip one with \`hq answer ${target}\` instead \
(then your final message isn't shown): --ink <strokes.json> a drawing, --form <questions.json> a few questions for \
the board to fill in, --asks your own question to the board, --picture <png> a picture.`;
function groupBrief(g: Group, top: Group, page: number, why: string) {
  const box = boxOf(partsOf(top)) ?? { x: 0, y: 0, w: 0, h: 0 };
  const typed = (JSON.parse(g.texts) as { text: string }[]).map(x => x.text).join('\n');
  const words = g.words || typed || '(no words: see it on the page)';
  const reply =
    g.parent !== null ? ' It replies to an answer under a note of the board’s: the page shows the thread.' : '';
  return `The board wrote a note in its notebook, in HQ, for you.${reply} ${ANSWER_FIRST} \`hq sketch ${page}\` saves \
its page; the note is at x ${Math.round(box.x)}, y ${Math.round(box.y)}, ${Math.round(box.w)} × ${Math.round(box.h)} px \
on it. ${RICHER(`g${g.id}`)}

Why it calls for an answer: ${why}

The note's words, the board's (read from its handwriting when it wrote them):
${words}`;
}
const noteBrief = (review: number, text: string, why: string) => `The board wrote a note on a page in HQ, in its book, \
for you. ${ANSWER_FIRST} \`hq note ${review}\` saves the note's snip (the page around its mark). ${RICHER(String(review))}

Why it calls for an answer: ${why}

${text}`;
onQuickRun(PURPOSE, {
  // (the notebook's open pages read again: a face waiting for its turn becomes the owner writing, bookslips.ts waitingOf)
  started: job => publish({ type: 'book', agent: job.agent, text: 'notebook' }),
  // Its final message is the answer, unless it clipped one itself (a run that ended without one says why where it asked:
  // bookslips.ts waitingOf)
  heard: (job, status, result) => {
    const answered = !!db.prepare('select 1 from book_slips where job = ?').get(job);
    const g = db.prepare('select * from notebook_groups where asked = ?').get(job) as Group | undefined;
    const n = g ? undefined : (db.prepare('select * from book_notes where asked = ?').get(job) as Note | undefined);
    if (status === 'done' && result && !answered && (g || n))
      return void clipText(g ? { grp: g.id } : { note: n!.id }, jobAgent(job) ?? ceo(), result.slice(0, SLIP_MAX), job);
    // (no answer: the dots go)
    const p = g && pageRow(rootOf(g).page, null);
    if (p) changed(p.notebook, p.id);
  },
});

// ---------------------------------------------------------------- no answer
// What the board reads in an answer's place when the note couldn't be judged or came past the judge's day
// (bookjudge.ts). A reply under it is judged as any note: it can ask again.
export const NO_ANSWER = {
  unread: 'No answer: this note couldn’t be read for one. Write under this to ask again.',
  day: 'No answer today: the day’s notes read for one are used up. It still goes when its page is sent.',
};
// A judged note that gets no answer: why, as a text answer from the agent who'd have written it, where it would lie.
// One reason a target: a later one rewrites the slip shown (reasonAt), and the next ask or answer takes its place
// (forgetReason). The slip's id, or null when the note is gone.
export function noAnswer(t: Target, why: keyof typeof NO_ANSWER) {
  const by = ownerOf(t);
  if (by === null) return null;
  const at = reasonAt(t);
  if (at.reason === null) {
    const id = clipText(t, by, NO_ANSWER[why]);
    db.prepare(`update ${at.table} set reason = ? where id = ?`).run(id, at.id);
    return id;
  }
  db.prepare('update book_slips set by = ?, text = ? where id = ?').run(by, NO_ANSWER[why], at.reason);
  told(slipBy(at.reason));
  landedIn(at.top);
  return at.reason;
}
// Where a target's reason is kept (reason: the slip shown): on the group it's on, else on its old book's note
function reasonAt(t: Target) {
  const g = groupOn(t);
  if (g) return { table: 'notebook_groups', id: g.id, reason: g.reason, top: rootOf(g) };
  const n = db.prepare('select reason from book_notes where id = ?').get(t.note!) as { reason: number | null };
  return { table: 'book_notes', id: t.note!, reason: n.reason, top: undefined };
}

// ---------------------------------------------------------------- clipping an answer on
// A text answer on a group or a note (a call's agent's too, booktry.ts): the slip's id
export const clipText = (t: Target, by: string, text: string, job: number | null = null) =>
  clip(t, by, job, text, { style: 'text' }).id;
// An answer on a target: its spot decided once (a group's, beside it on free paper; a version's lies on its versions
// page, none), and the page told. a: what it holds, for its height (its words alone, if not given)
function clip(t: Target, by: string, job: number | null, text: string, more: More, a?: Contents) {
  forgetReason(t);
  const g = groupOn(t);
  const top = g && rootOf(g);
  let spot: Spot | null = null;
  if (top && more.style !== 'version') {
    const asked = job !== null && g!.asked === job && g!.asked_spot ? (JSON.parse(g!.asked_spot) as Spot) : null;
    spot = placeFor(top, a ?? { text }, asked, job);
  }
  const slip = addSlip(t.grp !== undefined ? (g?.note ?? null) : t.note!, by, job, text, {
    ...more,
    grp: more.style === 'version' && top ? top.id : (g?.id ?? null),
    spot: spot && JSON.stringify(spot),
  });
  landedIn(top);
  // (a version of an old book's note, a call's: its versions page fills in.)
  const tries = !top && more.style === 'version' ? triesPageOfNote(t.note!) : undefined;
  if (tries) changed(tries.notebook, tries.id);
  if (more.style === 'version') heardOnCall(t);
  return slip;
}
// A new ask or answer on a target takes the place of the reason none came: the reason goes, unless the board wrote
// under it
function forgetReason(t: Target) {
  const at = reasonAt(t);
  if (at.reason === null) return;
  const slip = slipBy(at.reason);
  db.prepare(`update ${at.table} set reason = null where id = ?`).run(at.id);
  db.prepare(
    `delete from book_slips where id = ? and id not in (select answers from notebook_groups where answers is not null)
    and id not in (select answers from book_notes where answers is not null)`,
  ).run(at.reason);
  told(slip);
}
const slipBy = (id: number) =>
  db.prepare('select note, by from book_slips where id = ?').get(id) as { note: number | null; by: string };
// A slip changed or gone: its old book's page is told (a group's page: landedIn, changed)
const told = (slip: { note: number | null; by: string }) =>
  publish({ type: 'book', agent: slip.by, text: 'slip', ...(slip.note === null ? {} : notePage(slip.note)) });
// An answer landed in a group's thread: the thread moves on, and its page is told
const landedIn = (top: Group | undefined) => {
  if (!top) return;
  movedOn(top);
  const p = pageRow(top.page, null);
  if (p) changed(p.notebook, p.id);
};
// The thread moves on (its next ask starts, or an answer lands in it): an ask in it that ended without an answer stops
// saying why (bookslips.ts waitingOf)
const movedOn = (top: Group) =>
  db
    .prepare(
      `update notebook_groups set asked = null, asked_spot = null where (id = ? or parent = ?)
      and asked not in (select id from jobs where status in ('queued', 'running'))
      and asked not in (select job from book_slips where job is not null)`,
    )
    .run(top.id, top.id);

// ---------------------------------------------------------------- hq answer
// POST /api/agent/answer { note | grp, text?, picture?, link?, artifact?, ink?, form?, asks?, version?, patch?, expect? }
// (hq answer): an agent's answer clipped onto a note the board sent it (note: its number in the job's brief, a sent
// note's on HQ) or onto a group (grp, the quick run's or try run's brief names it). Who answers: the job holding the
// note, or the quick run or try run started for that group or note. A note held is answered too (feedback.ts
// markAnswered's), unless the job marked it fixed or answered. expect alone: how many versions the try makes.
export function answer(b: any, me: Reader) {
  const target = targetOf(b, me);
  if (isRefused(target)) return target;
  const top = target.group && rootOf(target.group);
  if (b.expect !== undefined) {
    const n = Number(b.expect);
    if (!Number.isInteger(n) || n < 1 || n > EXPECT_MAX)
      return [400, `expect is how many versions the try makes, 1 to ${EXPECT_MAX}`] as Refused;
    // (an old book's note shows no empty frames: only a group keeps the count)
    const p = top && pageRow(top.page, null);
    if (p) {
      db.prepare('update notebook_groups set expect = ? where id = ?').run(n, top.id);
      changed(p.notebook, p.id);
    }
    if (!b.text && !b.picture && !b.version) return { expect: n };
  }
  const parts = partsOfAnswer(b);
  if (isRefused(parts)) return parts;
  return inOneStep(() => {
    const t = target.group ? { grp: target.group.id } : { note: target.note!.id };
    const slip = clip(t, me.agent, me.id || null, parts.text, parts.more, parts.contents);
    if (parts.patch) {
      const file = `patch${slip.id}-${randomBytes(4).toString('hex')}.diff`;
      keepFile(`${DIR}/${file}`, Buffer.from(parts.patch));
      db.prepare('update book_slips set patch = ? where id = ?').run(file, slip.id);
    }
    if (target.held) feedback.answeredInBook(target.note!.review!, parts.text || `(${parts.more.style})`);
    return { slip: slipOf(db.prepare('select * from book_slips where id = ?').get(slip.id) as Slip) };
  });
}
// Whose the answer is: a group's quick run's or try run's, a note's holder's or its quick run's
function targetOf(b: any, me: Reader): { group?: Group; note?: Note; held?: boolean } | Refused {
  if (b?.grp !== undefined) {
    const g = row(Number(b.grp));
    const thread =
      g &&
      (db.prepare('select asked from notebook_groups where id = ? or parent = ?').all(rootOf(g).id, rootOf(g).id) as {
        asked: number | null;
      }[]);
    if (!g || g.deleted !== null || !(thread!.some(x => x.asked === me.id) || tryHolds(g.id, me.id)))
      return [404, `group g${b.grp} isn't one you were asked to answer`];
    return { group: g };
  }
  const n = db.prepare('select * from book_notes where review = ?').get(Number(b?.note)) as Note | undefined;
  const holder =
    n && (db.prepare('select job from review_notes where id = ?').get(n.review) as { job: number | null }).job;
  const held = !!holder && jobAgent(holder) === me.agent;
  if (!n || !(held || (n.asked && n.asked === me.id) || tryHolds(n.id, me.id, true)))
    return [404, `note ${b?.note} isn't one of the board's book notes sent to you`];
  return { note: n, group: groupOfNote(n.id), held };
}
// ---------------------------------------------------------------- the board's side
// POST /api/notebooks/answers/form { id, answers }: the board's answers to an answer's form, kept and gone to the agent
// as a reply (a note on a sheet of its own, as groups/reply's)
export function answerForm(b: any, who = BOARD) {
  const slip = slipRow(Number(b?.id), who);
  if (!slip?.form) return 404;
  if (slip.form_answer) return [409, 'this form has been answered'] as Refused;
  const form = JSON.parse(slip.form) as { title: string }[];
  if (!Array.isArray(b.answers) || b.answers.length !== form.length)
    return [400, 'answers is one answer per question, in their order'] as Refused;
  const answers = form.map((q, k) => asking.given(q, b.answers[k]));
  const wrong = answers.findIndex(a => a === null);
  if (wrong >= 0) return [400, `question ${wrong + 1}: that answer doesn't fit it`] as Refused;
  const g = groupOn(slip);
  const top = g && rootOf(g),
    p = top && pageRow(top.page, who);
  inOneStep(() => {
    db.prepare('update book_slips set form_answer = ? where id = ?').run(JSON.stringify(answers), slip.id);
    const said = { words: asking.answerLines(form, answers), said: 'typed' };
    if (top && p) replyNote(p.id, anchorOf(top), slip, said, null, who);
  });
  if (p) changed(p.notebook, p.id);
  publish({ type: 'book', agent: slip.by, text: 'slip' });
  return { answer: slipOf(slipRow(slip.id, who)!) };
}
// POST /api/notebooks/answers/tick { id, ticked }: a tick closes an answer (its note's too, once none of its answers is
// open); on a version it picks it, the rest of its set not (bookpick.ts pick; false: open again, unpicked)
export function tickAnswer(b: any, who = BOARD) {
  const slip = slipRow(Number(b?.id), who);
  if (!slip) return 404;
  if (typeof b.ticked !== 'boolean') return [400, 'ticked is true or false'] as Refused;
  const at = b.ticked ? new Date().toISOString() : null;
  if (slip.style === 'version' && at) pick(slip);
  else
    db.prepare(`update book_slips set ${slip.style === 'version' ? 'picked' : 'ticked'} = ? where id = ?`).run(
      at,
      slip.id,
    );
  if (slip.note !== null && slip.style !== 'version') {
    const open = db.prepare('select 1 from book_slips where note = ? and ticked is null').get(slip.note);
    db.prepare(`update book_notes set status = ? where id = ? and status != 'open'`).run(
      open ? 'sent' : 'closed',
      slip.note,
    );
  }
  const g = groupOn(slip);
  const p = g && pageRow(rootOf(g).page, who);
  if (p) changed(p.notebook, p.id);
  publish({ type: 'book', agent: slip.by, text: 'slip' });
  return {
    answer: slipOf(slipRow(slip.id, who)!),
    ...(slip.note !== null && !g ? { note: shown(note(slip.note)!) } : {}),
  };
}
// GET /api/notebooks/open: what waits on the board: answers with a form not answered yet, and the agents' questions
// with no reply or tick yet, oldest first
export function openList(who = BOARD) {
  const rows = db
    .prepare(
      `select * from book_slips s where s.ticked is null and s.picked is null
      and ((s.form is not null and s.form_answer is null) or (s.style = 'question'
        and not exists (select 1 from notebook_groups r where r.answers = s.id and r.deleted is null)
        and not exists (select 1 from book_notes n where n.answers = s.id)))
      order by s.id`,
    )
    .all() as Slip[];
  const items = rows.filter(s => slipRow(s.id, who)).map(s => itemOf(s, who));
  return {
    forms: items.filter(i => i.form).map(({ form: _form, ...i }) => i),
    questions: items.filter(i => !i.form).map(({ form: _form, ...i }) => i),
  };
}
function itemOf(s: Slip, who: string) {
  const g = groupOn(s);
  const top = g && rootOf(g);
  const page = top
    ? top.page
    : (db.prepare('select page from book_notes where id = ?').get(s.note) as { page: number | null } | undefined)?.page;
  const p = page
    ? (db.prepare('select notebook, day from book_pages where id = ? and who = ?').get(page, who) as
        { notebook: number | null; day: string } | undefined)
    : undefined;
  return {
    id: s.id,
    group: top?.id ?? null,
    page: page ?? null,
    notebook: p?.notebook ?? null,
    day: p?.day ?? null,
    by: s.by,
    name: findAgent(s.by)?.name ?? s.by,
    text: s.text,
    created: s.created,
    form: !!s.form,
  };
}
