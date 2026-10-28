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
import { db, inOneStep } from '../db.ts';
import { publish } from '../events.ts';
import { ceo } from '../company.ts';
import { findAgent, jobAgent, type Reader } from '../jobs.ts';
import * as feedback from '../feedback.ts';
import { onQuickRun, quickRun } from '../chat.ts';
import { keepFile } from '../uploads.ts';
import * as asking from '../../../hq/shell/questions.js';
import { pictureSize } from '../../../../shared/pictures/size.ts';
import { BOARD } from './book.ts';
import { note, sheetRow, shown, type Note } from './booknotes.ts';
import { keep } from './booksheets.ts';
import { ARTIFACT, LINK_MAX, SLIP_MAX, addSlip, slipOf, slipRow, type More, type Slip } from './bookslips.ts';
import { type Contents, type Spot } from './answerspot.ts';
import { placeFor, QUICK_WORDS } from './answerplace.ts';
import { onCall, tryHolds } from './booktry.ts';
import { dataUrlPicture, GROWN_MAX, inkOf, isRefused, type Refused, type Stroke } from '../pagechecks.ts';
import { DIR } from '../pagescraps.ts';
import { changed, pageRow, triesPageOfNote } from '../notebook.ts';
import { partsOf, row, type Group } from '../notebookgroups.ts';
import { boxOf } from '../notebookparts.ts';
import { anchorOf, replyNote } from '../notebooksend.ts';

export type Target = { grp?: number; note?: number };
// A patch kept with a version, and the versions a try may say it makes
const PATCH_MAX = 1_000_000,
  EXPECT_MAX = 12;

// A call's agent hears what's new on a note on its live call (callanswer.ts: imported when it's needed, as bookjudge.ts
// does this file, for the cycle through the judge)
const heardOnCall = (t: Target) => void import('./callanswer.ts').then(m => m.heardOnCall(t));

// ---------------------------------------------------------------- the quick run
// The owner's quick run for a verdict 'answer': a group's (its scrap's owner, else its page's, else the CEO) or a
// note's (its sheet's owner, else the CEO). Not on a call: there the call's agent answers itself (booktry.ts onCall).
const PURPOSE = 'ink-answer';
export function answerNow(t: Target, verdict: { id: number; why: string }) {
  if (onCall(t) !== null) {
    heardOnCall(t); // (the call's agent hears it calls for an answer: it writes it itself)
    return null;
  }
  if (t.grp !== undefined) {
    const g = row(t.grp),
      top = g && rootOf(g),
      p = top && pageRow(top.page, null);
    if (!g || !top || !p || g.deleted !== null) return null;
    const agent = top.owner ?? p.owner ?? ceo();
    const spot = placeFor(top, { text: QUICK_WORDS }, null, null);
    const job = quickRun(agent, 'A note in the board’s notebook', groupBrief(g, top, p.id, verdict.why), PURPOSE);
    db.prepare('update notebook_groups set asked = ?, asked_spot = ? where id = ?').run(
      job,
      JSON.stringify(spot),
      g.id,
    );
    changed(p.notebook, p.id);
    return job;
  }
  const n = t.note === undefined ? undefined : note(t.note);
  if (!n) return null;
  const agent = sheetRow(n.sheet, null)?.owner ?? ceo(),
    kept = keep(n, null);
  const job = quickRun(agent, 'A note in the board’s book', noteBrief(kept.id, kept.text, verdict.why), PURPOSE);
  feedback.fromBook(kept.from, job);
  db.prepare('update book_notes set asked = ? where id = ?').run(job, n.id);
  return job;
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
// Its final message, the answer, unless it clipped one itself (a run that failed leaves the note as it was)
onQuickRun(PURPOSE, (job, status, result) => {
  const answered = !!db.prepare('select 1 from book_slips where job = ?').get(job);
  const g = db.prepare('select * from notebook_groups where asked = ?').get(job) as Group | undefined;
  const n = g ? undefined : (db.prepare('select * from book_notes where asked = ?').get(job) as Note | undefined);
  if (status === 'done' && result && !answered && (g || n))
    return void clipText(g ? { grp: g.id } : { note: n!.id }, jobAgent(job) ?? ceo(), result.slice(0, SLIP_MAX), job);
  // (no answer: the dots go)
  const p = g && pageRow(rootOf(g).page, null);
  if (p) changed(p.notebook, p.id);
});

// ---------------------------------------------------------------- clipping an answer on
// A text answer on a group or a note (a call's agent's too, booktry.ts): the slip's id
export const clipText = (t: Target, by: string, text: string, job: number | null = null) =>
  clip(t, by, job, text, { style: 'text' }).id;
// An answer on a target: its spot decided once (a group's, beside it on free paper; a version's lies on its versions
// page, none), and the page told. a: what it holds, for its height (its words alone, if not given)
function clip(t: Target, by: string, job: number | null, text: string, more: More, a?: Contents) {
  const g = t.grp !== undefined ? row(t.grp) : groupOfNote(t.note!);
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
  const p = top && pageRow(top.page, null);
  if (p) changed(p.notebook, p.id);
  // (a version of an old book's note, a call's: its versions page fills in.)
  const tries = !top && more.style === 'version' ? triesPageOfNote(t.note!) : undefined;
  if (tries) changed(tries.notebook, tries.id);
  if (more.style === 'version') heardOnCall(t);
  return slip;
}
const rootOf = (g: Group) => (g.parent === null ? g : (row(g.parent) ?? g));
const groupOfNote = (noteId: number) =>
  db.prepare('select * from notebook_groups where note = ?').get(noteId) as Group | undefined;

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
// What an answer holds, checked: its words, style and the rest, and what sizes it for its spot
function partsOfAnswer(b: any): { text: string; more: More; patch: string | null; contents: Contents } | Refused {
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (text.length > SLIP_MAX) return [400, `an answer's text is at most ${SLIP_MAX} characters`];
  const link = b.link == null ? null : String(b.link);
  if (link !== null && !(/^https:\/\/[^\s]+$/.test(link) && link.length <= LINK_MAX))
    return [400, 'a link is an https address'];
  const picture = b.picture == null ? null : dataUrlPicture(b.picture);
  if (isRefused(picture)) return picture;
  const artifact = b.artifact ?? null;
  if (
    artifact !== null &&
    !(typeof artifact === 'string' && ARTIFACT.test(artifact) && !artifact.split('/').includes('..'))
  )
    return [400, "an artifact is its id, as HQ's artifacts list it: an app's slug, or a path"];
  const ink = b.ink == null ? null : inkOf(b.ink);
  if (isRefused(ink)) return ink;
  const form = b.form == null ? null : asking.questions(b.form);
  if (typeof form === 'string') return [400, `a form: ${form}`];
  const version = b.version == null ? null : String(b.version).trim();
  if (version !== null && !/^\S+( \S+)?$/.test(version)) return [400, "a version's name is two words"];
  if (version !== null && !picture) return [400, 'a version is a picture of the thing changed: --picture'];
  const patch = b.patch == null ? null : String(b.patch);
  if (patch !== null && (!version || patch.length > PATCH_MAX))
    return [400, `a patch (at most ${PATCH_MAX} bytes) goes with a version`];
  const style = version ? 'version' : form ? 'form' : b.asks ? 'question' : ink ? 'drawing' : 'text';
  if (!text && !picture && !ink?.length && !version) return [400, 'an answer is text, a picture, ink or a version'];
  if ((style === 'form' || style === 'question') && !text) return [400, `a ${style} has words: what it asks`];
  const contents = contentsOf(text, picture, ink, form as unknown[] | null);
  if (isRefused(contents)) return contents;
  return {
    text,
    patch,
    contents,
    more: {
      picture,
      link,
      artifact,
      style,
      version,
      ink: ink && JSON.stringify(ink),
      form: form && JSON.stringify(form),
    },
  };
}

// What sizes an answer for its spot, its ink no bigger than a page grows (so placing it stays a few steps)
function contentsOf(
  text: string,
  picture: { clean: Buffer } | null,
  ink: Stroke[] | null,
  form: unknown[] | null,
): Contents | Refused {
  const inkBox = ink && boxOf({ ink, texts: [], pictures: [] });
  if (inkBox && (inkBox.w > GROWN_MAX || inkBox.h > GROWN_MAX))
    return [400, `an answer's ink fits on a page: at most ${GROWN_MAX} px a side`] as Refused;
  const size = picture && pictureSize(picture.clean);
  return { text, picture: size, ink: inkBox?.h ?? 0, questions: form?.length ?? 0 };
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
  const g = slip.grp !== null ? row(slip.grp) : groupOfNote(slip.note!);
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
// open); on a version it picks it (false: open again, unpicked)
export function tickAnswer(b: any, who = BOARD) {
  const slip = slipRow(Number(b?.id), who);
  if (!slip) return 404;
  if (typeof b.ticked !== 'boolean') return [400, 'ticked is true or false'] as Refused;
  const at = b.ticked ? new Date().toISOString() : null;
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
  const g = slip.grp !== null ? row(slip.grp) : slip.note !== null ? groupOfNote(slip.note) : undefined;
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
  const g = s.grp !== null ? row(s.grp) : groupOfNote(s.note!);
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
