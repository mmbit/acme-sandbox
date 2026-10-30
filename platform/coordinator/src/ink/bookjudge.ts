// The book's judge: every note the board makes in its book, once its words have settled, is read by a small model that
// says whether it calls for a reply now and what kind:
//   - answer: a question or a doubt a few words settle; the quick run writes them (bookanswer.ts answerNow).
//   - try: a change to something the board can see, where a few versions to look at help it decide (booktry.ts tryNow).
//   - pick: a reply on one of a try's versions that chooses it; that version is picked (bookpick.ts pickNow).
//   - none: everything else, most notes: it waits for its sheet as ever, and shows nothing.
// It's guided, not ruled: the prompt says what each reply is for and shows real notes with their verdicts. Nothing here
// looks at the words' shape. Each verdict is kept with its why (ink_verdicts), so a wrong call can be found: a reply the
// board wiped unread is marked (markWiped), and that's the list the examples learn from. A note it can't judge (the
// model gave no verdict, or the day's JUDGES_A_DAY are used) says why where its answer would lie (unjudged).
// What it judges (a target): a group on a notebook page (grp: a scrap, a drawing, a reply under an answer), a note on the
// old book's pages (note), or a box typed on one (page + text: booktyped.ts). Only the board's own: a guest's note is
// outside text (charter rule 9) and waits for the board's plane. Judging runs after the board's request has answered.
import { db, lacks, once, redacted } from '../db.ts';
import { companyDay } from '../company.ts';
import { answerOf, smallCall } from '../smallmodel.ts';
import { isRefused } from '../pagechecks.ts';
import { BOARD } from './book.ts';
import { answeredOf, seenOf, type Seen } from './bookseen.ts';

// Each judging spends a little of a Claude seat's window, which the company's jobs live on: JUDGES_A_DAY bounds what a
// page or a client gone wrong can take in a day, as handwriting's READS_A_DAY does. It's the judge's only limit: a day
// of the board's notes is a few dozen to a hundred or two.
export const JUDGES_A_DAY = 400;
// How long a verdict may take: nobody waits on it, the worker's small calls take their turn (a seat's slow minute too)
const WAIT_MS = 10 * 60_000;
const WHY_MAX = 300;

// grp: a notebook group's; note: an old-book note's; page: a typed box's page. words: what was judged (a later edit to the
// same words isn't judged again). wiped: when the board wiped the reply unread. saved: when the words judged were saved
// (their group's, note's or page's updated); job: the run its route started or joined, whose answers are its own
// (book_slips.job; a typed box's is typed on at the run's end): what the status report measures it by (infra/report.sh).
db.exec(`create table if not exists ink_verdicts (id integer primary key autoincrement, grp integer, note integer,
  page integer, reply text not null, why text not null, words text not null, created text not null, wiped text,
  saved text, job integer);
  create index if not exists ink_verdicts_grp on ink_verdicts (grp) where grp is not null;
  create index if not exists ink_verdicts_note on ink_verdicts (note) where note is not null;
  create table if not exists ink_judges (day text primary key, judges integer not null)`);
redacted('ink_verdicts', 'why', 'words');
once('2026-10-28-ink-verdicts-runs', () => {
  for (const column of ['saved text', 'job integer'])
    if (lacks('ink_verdicts', column.split(' ')[0])) db.exec(`alter table ink_verdicts add column ${column}`);
});

// The replies a verdict can be, the one list the type, the routes and the model's schema are read from
const REPLIES = ['none', 'answer', 'try', 'pick'] as const;
export type Reply = (typeof REPLIES)[number];
export type Target = { grp?: number; note?: number; page?: number; text?: string };
export type Verdict = { id: number; reply: Reply; why: string };
// Where a verdict goes, one route a reply but none, each given the target and the verdict: answer and try give the run
// they started or joined (null: none, as on a call, where the call's agent answers itself)
type Route<R> = (t: Target, v: { id: number; why: string }) => R;
type Run = number | null | Promise<number | null>;
export type Routes = Record<'answer' | 'try', Route<Run>> & { pick: Route<unknown> };
const routes: Routes = {
  // (loaded when a verdict comes: they read the book, which reads this)
  answer: (t, v) => import('./bookanswer.ts').then(m => m.answerNow(t, v)),
  try: (t, v) => import('./booktry.ts').then(m => m.tryNow(t, v)),
  pick: t => import('./bookpick.ts').then(m => m.pickNow(t)),
};

// The verdict asked of the model: pick is offered only for a note on a version, the one thing a pick can choose
export const schemaOf = (onVersion: boolean) => ({
  type: 'object',
  properties: {
    reply: {
      type: 'string',
      enum: REPLIES.filter(r => onVersion || r !== 'pick'),
      description:
        'answer: a few words settle it; try: a few versions to look at; pick: on a version, it chooses that one; none: no reply now',
    },
    why: { type: 'string', maxLength: WHY_MAX, description: 'one short line: what the note asks for, so this reply' },
  },
  required: ['reply', 'why'],
  additionalProperties: false,
});
// (its examples name no company's agents)
const PROMPT = `You read one note the board (the person who runs the company) just made in its book in HQ, and decide \
whether an agent replies to it right away, and how. A note is a mark on a page: words written by hand (read into type, \
so a word may be misread), typed or said aloud, often with a ring, an arrow or a scribble on the page around it, which \
the picture shows. Every note reaches its agent with its sheet later in any case: a reply now comes on top of that.

- answer: the board asks or doubts something, and a few words from an agent settle it: what something on the page \
means, whether something is done or live, why something is the way it is. An agent writes a short answer beside the note.
- try: the board asks for a change to something it can see, or wonders about one, and seeing a few versions side by \
side would help it decide: a colour, a size, a picture, a layout, words it isn't sure of. An agent makes a few versions.
- pick: only for a note on one of an agent's versions (it replies to a version): the board chooses that version. A \
ring drawn round it, a tick on it, an arrow at it with "deze", "this one" or "ja". \
The picture shows the version's frame with the board's ink over it. A note on a version that asks for more ("this, but \
softer") is a try, a doubt about it an answer, and a cross through it or "nee" none.
- none: everything else, and that's most notes: work that's clear as written (it's done when the sheet goes), a \
reminder, a thought, a reaction, a tick, a scribble. None costs nothing and shows nothing.

Judge what the board means, in whatever language it writes, never how the words look: a question can come without a \
question mark, and a plain request can end in one. Read past misspellings from handwriting. When the words alone don't \
settle it, the picture, the page and what the note replies to do. Between answer and none: an answer nobody needed \
costs little, a doubt left hanging costs more. Choose try only when versions would really help the board decide.

why: one short line for whoever checks the verdicts later: what the note asks for, and so this reply.

Notes and their verdicts:
- "what does reach count here" (written, a ring round a figure on HQ's Gazette page) -> answer: asks what a figure means; a sentence settles it.
- "is this live yet" (typed, on a shop's product page) -> answer: asks whether it has shipped.
- "waarom?" (written, an arrow at a paused project in HQ) -> answer: asks why it's paused; the agent can say.
- "ik snap niet waar dit getal vandaan komt" (said, on an invoice page) -> answer: a doubt about where a number comes from, no question mark needed.
- "warmer?" (written, a ring round an app's header) -> try: wonders about a colour; versions show it.
- "try this bigger" (written, a ring round a logo) -> try: a visible change whose right size is a matter of looking.
- "misschien hier een foto" (said, on a landing page's opening) -> try: wonders about a picture there; a few to choose from.
- "swap" (written, a ring and an arrow between two cards) -> try: a layout change best judged by seeing it.
- "fix the typo" (written, a ring round "recieve") -> none: clear work, done when the sheet goes.
- "Can you make the button blue?" (typed, on HQ's settings page) -> none: a clear request, work to do, not a question to answer.
- "vrijdag Ada over de facturen" (written, on a free page) -> none: a reminder to self.
- no words, a ring round a button (written) -> none: a mark with nothing asked; it goes with its sheet.
- "mooi ✔" (written, on a film's still) -> none: a reaction.
- "and last week?" (written, replying to the answer "Reach counts unique readers over 7 days.") -> answer: asks for one more figure.
- "ok doe maar" (written, replying to an answer suggesting a fix) -> none: a go-ahead, the work follows.
- no words, a ring round the whole frame (written, on version 2 of 3, "Brick red") -> pick: rings one version to choose it.
- "✔" (written, on version 1 of 3, "Sand and honey") -> pick: ticks the version it likes.
- "this, but softer" (written, on version 3 of 3, "Late sun") -> try: wants one more round from that version.
- a cross over the frame (written, on version 1 of 2, "Bold") -> none: rules that one out, nothing to choose yet.`;

const SAID: Record<string, string> = {
  written: 'written by hand, read into type',
  typed: 'typed',
  spoken: 'said aloud',
};
// (in flight: a target and its words, so a quick second save of the same words doesn't judge them twice)
const judging = new Set<string>();

// The target judged, its verdict kept and routed (null: not the board's, judged as it is, past the day's bound, gone or
// changed while it was judged, or the model gave no use). Never throws: a judge that fails leaves the note as it is.
// via: where its verdict goes, when not answerNow and tryNow (a typed box: booktyped.ts)
export async function judge(t: Target, via?: Partial<Routes>): Promise<Verdict | null> {
  try {
    const seen = await seenOf(t);
    if (!seen || seen.by !== BOARD) return null;
    const key = `${keyOf(t)}:${seen.words}`;
    if (judging.has(key) || verdictOf(t)?.words === seen.words) return null;
    if (!counted()) {
      console.error(`The book's judge: ${JUDGES_A_DAY} notes judged today, ${keyOf(t)} not`);
      return unjudged(t, 'day');
    }
    judging.add(key);
    const said = await ask(seen).finally(() => judging.delete(key));
    // (changed while it was judged: the newer words are judged in their turn)
    if ((await seenOf(t, false))?.words !== seen.words) return null;
    if (isRefused(said)) {
      console.error(`The book's judge: ${keyOf(t)} wasn't judged: ${said[1]}`);
      return unjudged(t, 'unread');
    }
    const v = keep(t, said, seen),
      { reply } = v;
    if (reply !== 'none')
      Promise.resolve()
        .then(() => (via?.[reply] ?? routes[reply])(t, { id: v.id, why: v.why }))
        .then(job => {
          if (reply !== 'pick' && typeof job === 'number')
            db.prepare('update ink_verdicts set job = ? where id = ?').run(job, v.id);
        })
        .catch(err => console.error(`The book's judge: ${keyOf(t)}'s ${reply} didn't start:`, err));
    return v;
  } catch (err) {
    console.error(`The book's judge: ${keyOf(t)} wasn't judged:`, err);
    return null;
  }
}
// A group or a note left unjudged says why where its answer would lie (a typed box's page has no place for it)
function unjudged(t: Target, why: 'day' | 'unread') {
  if (t.grp || t.note)
    void import('./bookanswer.ts')
      .then(m => m.noAnswer(t, why))
      .catch(err => console.error(`The book's judge: ${keyOf(t)}'s reason wasn't shown:`, err));
  return null;
}
// judge() after the board's request has answered: the routes call this
export function judgeLater(t: Target) {
  setImmediate(() => void judge(t));
}
// A group edited (notebookgroups.ts editGroup), as it was: judged again only when its words changed
export function judgeEdited(was: { id: number; words: string; texts: string }, words: string, texts: unknown[]) {
  if (words !== was.words || JSON.stringify(texts) !== was.texts) judgeLater({ grp: was.id });
}

// The latest verdict on a target (a call's agent reads it with the note: bookcalls.ts)
export function verdictOf(t: Target) {
  const [column, value] = t.grp ? ['grp', t.grp] : t.note ? ['note', t.note] : ['page', t.page];
  const extra = t.grp || t.note ? '' : ' and words = ?';
  const args = t.grp || t.note ? [value ?? null] : [value ?? null, t.text ?? ''];
  return db
    .prepare(
      `select id, reply, why, words, created, wiped from ink_verdicts where ${column} = ?${extra} order by id desc limit 1`,
    )
    .get(...args) as (Verdict & { words: string; created: string; wiped: string | null }) | undefined;
}

// An answer (a book_slips row) the board wiped unread: its verdict marked, the list to learn the examples from. Its
// target is the slip's group (grp), else its note, else the group that went as that note. 1 when a verdict was marked.
export function markWiped(answerId: number) {
  const s = db.prepare('select * from book_slips where id = ?').get(answerId) as
    { note: number | null; grp?: number | null } | undefined;
  if (!s) return 0;
  const found = db
    .prepare(
      `select id from ink_verdicts where reply != 'none' and (grp = ? or note = ?
        or grp in (select id from notebook_groups where note = ?)) order by id desc limit 1`,
    )
    .get(s.grp ?? null, s.note ?? null, s.note ?? null) as { id: number } | undefined;
  if (!found) return 0;
  return db
    .prepare('update ink_verdicts set wiped = ? where id = ? and wiped is null')
    .run(new Date().toISOString(), found.id).changes;
}

// ---------------------------------------------------------------- the call
// The model asked for the verdict on a note as it was seen, and what it replies to
function ask(seen: Seen) {
  const image = seen.picture && {
    type: 'image',
    source: { type: 'base64', media_type: seen.picture.type, data: seen.picture.data.toString('base64') },
  };
  const answered = answeredOf(seen.answers),
    onVersion = !!answered?.isVersion;
  const about = [
    seen.words
      ? `Its words (${SAID[seen.said ?? ''] ?? 'typed'}): ${JSON.stringify(seen.words)}`
      : 'It has no words: only marks.',
    `Where: ${seen.where}.`,
    answered ? `It replies to an agent's answer: ${JSON.stringify(answered.text)}` : '',
    seen.picture ? 'The picture: the page around the note, its mark drawn on it.' : 'There is no picture of it.',
  ].filter(Boolean);
  return smallCall({
    name: "the book's judge",
    content: [...(image ? [image] : []), { type: 'text', text: `${PROMPT}\n\nThe note:\n${about.join('\n')}` }],
    schema: schemaOf(onVersion),
    check: (result: unknown) => verdictAnswer(result, onVersion),
    wait: WAIT_MS,
    keepAlive: false,
  });
}
function verdictAnswer(result: unknown, onVersion: boolean): { reply: Reply; why: string } | string {
  const a = answerOf(result);
  if (typeof a === 'string') return a;
  const offered = schemaOf(onVersion).properties.reply.enum;
  if (!offered.includes(a.reply as Reply)) return `a reply that is ${offered.join(', ')}`;
  const why = typeof a.why === 'string' ? a.why.replace(/\s+/g, ' ').trim().slice(0, WHY_MAX) : '';
  if (!why) return 'a verdict without its why';
  return { reply: a.reply as Reply, why };
}
// One more judging today, unless today's are used
function counted() {
  const day = companyDay(Date.now());
  const done = (db.prepare('select judges from ink_judges where day = ?').get(day) as { judges: number } | undefined)
    ?.judges;
  if ((done ?? 0) >= JUDGES_A_DAY) return false;
  db.prepare(
    'insert into ink_judges (day, judges) values (?, 1) on conflict (day) do update set judges = judges + 1',
  ).run(day);
  db.prepare('delete from ink_judges where day < ?').run(companyDay(Date.now() - 7 * 864e5));
  return true;
}
function keep(t: Target, v: { reply: Reply; why: string }, seen: Seen): Verdict {
  const id = Number(
    db
      .prepare(
        'insert into ink_verdicts (grp, note, page, reply, why, words, created, saved) values (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        t.grp ?? null,
        t.note ?? null,
        t.grp || t.note ? null : (t.page ?? null),
        v.reply,
        v.why,
        seen.words,
        new Date().toISOString(),
        seen.saved,
      ).lastInsertRowid,
  );
  return { id, ...v };
}
const keyOf = (t: Target) => (t.grp ? `group ${t.grp}` : t.note ? `note ${t.note}` : `a box on page ${t.page}`);
