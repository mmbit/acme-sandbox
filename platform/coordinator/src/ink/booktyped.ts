// A question typed on a page of the board's book (the board on call #239: a
// question typed on a call's page got no answer). Words the board types in a box on a page of its own book (book.ts
// texts: typed, or written into the box by hand) are judged when they're new, as a note's are (bookjudge.ts): a reply's verdict, answer or try, asks now and the page's agent answers in a quick run (a sheet's or a guest's page its owner, a call's page the call's
// agent, any other the CEO), and the answer is typed onto the page under the question, in the agent's ink, where the
// board sees it and the page's picture shows it. A box moved, or saved again as it was, asks nothing again; nor do the
// words in an invited person's book.
import { rmSync } from 'node:fs';
import { db } from '../db.ts';
import { publish } from '../events.ts';
import { ceo } from '../company.ts';
import { findAgent, jobAgent } from '../jobs.ts';
import { onQuickRun, quickRun } from '../chat.ts';
import * as book from './book.ts';
import { BOARD, drawnOf, row as pageRow, type Page } from './book.ts';
import { typedHeight } from './bookrender.ts';
import { GROWN_MAX, TEXTS_MAX, TEXT_MAX, isRefused, type Typed } from '../pagechecks.ts';
import { judge } from './bookjudge.ts';
import { DIR } from '../pagescraps.ts';
import { redact } from '../secrets.ts';
import { inkOf } from '../../../hq/shell/ink/agentink.js';

const TYPED = 'book-typed-question';
// (box: the question's box as it was asked, where the answer goes if the box has gone or changed since)
db.exec(
  'create table if not exists book_typed_asks (job integer primary key, page integer not null, box text not null)',
);
// The room between the question's last line and its answer, in page px
const ANSWER_GAP = 8;
// POST /api/book/page/save, the board's: book.ts savePage, then each box on a page of its own book with new words is
// judged once the request has answered (no box had the same words before: one moved or saved again as it was isn't).
// Only the board's own words are, as only its own notes are (booknotes.ts addNote's asking). A box isn't a note, so
// both replies ask here: an answer's quick run says what it would do when versions were called for.
export function savePage(b: any, who: string) {
  const id = Number(b?.id),
    texts = (page: number) => JSON.parse(drawnOf(page).texts) as Typed[];
  const mine = who === BOARD ? pageRow(id) : undefined,
    had = mine && new Set(texts(id).map(t => t.text));
  const saved = book.savePage(b, who);
  if (!mine || !had || typeof saved === 'number' || isRefused(saved)) return saved;
  const judged = new Set<string>();
  for (const t of texts(id))
    if (t.text.trim() && !had.has(t.text) && !judged.has(t.text)) {
      judged.add(t.text);
      const ask = () => askTyped(mine, t);
      setImmediate(() => void judge({ page: id, text: t.text }, { answer: ask, try: ask }));
    }
  return saved;
}
function askTyped(p: Page, box: Typed) {
  const agent = answererOf(p);
  const job = quickRun(agent, 'A question on a page in the board’s book', typedBrief(p.id, box.text), TYPED);
  db.prepare('insert into book_typed_asks (job, page, box) values (?, ?, ?)').run(job, p.id, JSON.stringify(box));
  return job;
}
// Whose page it is to answer on: a call's, the call's agent; one an agent owns, theirs; else the CEO's
function answererOf(p: Page) {
  const called =
    p.kind === 'call' &&
    (db.prepare('select agent from calls where id = ?').get(p.call) as { agent: string } | undefined)?.agent;
  const owner = called || p.owner;
  return owner && findAgent(owner) ? owner : ceo();
}
const typedBrief = (page: number, text: string) => `The board typed a question on a page of its book in HQ, for you. \
Answer it now: your final message is the answer, exactly as the board reads it, typed onto the page under its \
question. Plain words, the answer first, about 60 words, no Markdown. \`hq sketch ${page}\` shows the page if the \
question leans on what's drawn there. If it needs work rather than an answer, say what you'd do. Don't queue work, \
change files or ask the board for it.

The question: ${text}`;
// Its answer, typed on (a run that failed leaves the page as it was: the board asks again)
onQuickRun(TYPED, (job, status, result) => {
  const asked = db.prepare('select page, box from book_typed_asks where job = ?').get(job) as
    { page: number; box: string } | undefined;
  if (!asked || status !== 'done' || !result) return;
  typeAnswer(asked.page, JSON.parse(asked.box), jobAgent(job) ?? ceo(), result).catch(err =>
    console.error(`The answer to a question typed on page ${asked.page} wasn't typed on:`, err),
  );
});
// Under the question's box as the page has it now (the same words), or as it was asked; as wide, in the agent's ink
async function typeAnswer(page: number, asked: Typed, agent: string, result: string) {
  const p = pageRow(page);
  if (!p) return;
  const now = (JSON.parse(drawnOf(p.id).texts) as Typed[]).filter(t => t.text === asked.text);
  const box = now.find(t => t.x === asked.x && t.y === asked.y) ?? now.at(-1) ?? asked;
  // (model text: a saved key's value never stays in a page's words an agent can read, secrets.ts; an answer too long for a
  // box is refused, never cut short to look whole)
  const text = redact(result.replace(/\0/g, ''));
  if ([...text].length > TEXT_MAX) throw new Error(`the answer is over ${TEXT_MAX} characters`);
  const answer = { x: box.x, y: box.y + (await typedHeight(box)) + ANSWER_GAP, w: box.w, text, color: inkOf(agent) };
  typeOnto(p.id, answer, answer.y + (await typedHeight(answer)) + ANSWER_GAP, agent);
}

// An agent's words typed onto a page of the board's book, last of its boxes, the page grown down to foot (page px) to
// hold them and drawn again. A 'book' event names the page, so a book showing it reads it again. False: the page is
// gone. A page that holds all the boxes it can refuses with an error.
function typeOnto(id: number, t: Typed, foot: number, by: string) {
  const p = pageRow(id);
  const texts = p && (JSON.parse(drawnOf(p.id).texts) as Typed[]);
  if (!p || !texts) return false;
  if (texts.length >= TEXTS_MAX) throw new Error(`page ${id} holds all ${TEXTS_MAX} boxes it can`);
  const h = Math.min(Math.max(p.h, Math.ceil(foot)), GROWN_MAX);
  db.prepare('update book_pages set texts = ?, h = ?, picture = null, updated = ? where id = ?').run(
    JSON.stringify([...texts, t]),
    h,
    new Date().toISOString(),
    p.id,
  );
  if (p.picture) rmSync(`${DIR}/${p.picture}`, { force: true });
  publish({ type: 'book', agent: by, text: 'page', page: p.id });
  return true;
}
