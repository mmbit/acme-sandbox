// A page of the book as a picture: drawn here once a change (bookrender.ts), kept in the book's DIR until the next,
// and served. (moved here from book.ts)
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db, scrubbed, scrubStamp } from '../db.ts';
import * as latency from '../latency.ts';
import { keepFile } from '../uploads.ts';
import { render, underHigh, type Drawn, type Said, type Under } from './bookrender.ts';
import { DIR, notFound, serveFile } from '../pagescraps.ts';
import { BOARD, drawnOf, row, type Page } from './book.ts';
import { partsOf, shown, type Group, type Parts } from '../notebookgroups.ts';
import { CAPTION, boxOf, slipsUnder, underAt } from '../../../hq/shell/ink/notebookstack.js';
import { hasAny, shifted } from '../../../hq/shell/ink/notebookparts.js';
import { CARD, UNIT_W, bodyOf } from '../../../hq/shell/ink/scrapunit.js';
import type { Stroke, Typed } from '../pagechecks.ts';
import { layout, widthFor } from '../../../hq/shell/ink/masonry.js';
import { inkOf } from '../../../hq/shell/ink/agentink.js';
import { unfoldedCard } from '../../../hq/shell/card.js';
import { WORDS as ASKING, said } from '../../../hq/shell/questions.js';
import { asksOn } from './bookasks.ts';
import { versionsOf } from '../../../hq/shell/ink/bookversionsof.js';
import type { Asked, Form, Question } from './bookrenderasks.ts';
import type { Tried } from './bookrenderversions.ts';

// GET /api/book/picture?id=: the page as a picture, drawn here (an image or nothing, never kept in a cache)
export async function servePicture(req: IncomingMessage, res: ServerResponse, who: string | null = BOARD) {
  const p = row(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('id')), who);
  const file = p && (await pictureOf(p));
  if (!file) return notFound(res);
  serveFile(res, file);
}
// How the pictures kept are drawn, in their files' names: a page's picture drawn another way is drawn again when next
// read. Change it with what render() draws, or how a page lays its units out.
export const DRAWING = 'ac'; // (units as the grid's cards, the slip's shadows; exported for the tests)

// The page's picture's file in DIR: the one kept since its last change, or drawn now and kept. null: the page was
// deleted while it was drawn.
export async function pictureOf(p: Page): Promise<string | null> {
  // (and the cards and tries under its units: a card answered or a try ended changes no page. And the keys its words
  // were scrubbed for: a saved key's value leaves the picture as it leaves the words, db.ts scrubStamp)
  const drawing = `${p.id}-${DRAWING}${unitsMark(p.id)}-${scrubStamp().slice(0, 6)}-`,
    current = p.picture?.startsWith(drawing);
  if (current && existsSync(`${DIR}/${p.picture}`)) return p.picture;
  const page = db.prepare('select notebook from book_pages where id = ?').get(p.id) as { notebook: number | null };
  const png = await render(page.notebook === null ? bookPage(p) : await unitsPage(p.id), DIR);
  const name = `${drawing}${randomBytes(4).toString('hex')}.png`;
  keepFile(`${DIR}/${name}`, png);
  // (a change while it was drawn, or another draw of the same page kept first: this one goes, and the page's picture
  // now is the one read)
  const kept = db
    .prepare('update book_pages set picture = ? where id = ? and updated = ? and picture is ?')
    .run(name, p.id, p.updated, p.picture);
  if (!kept.changes) {
    rmSync(`${DIR}/${name}`, { force: true });
    const now = row(p.id, null);
    return now ? pictureOf(now) : null;
  }
  if (p.picture) rmSync(`${DIR}/${p.picture}`, { force: true });
  return name;
}

// A page of the book's own, from before the notebook: its ink, typed words and scraps where they lie
function bookPage(p: Page): Drawn {
  const { ink, texts } = drawnOf(p.id);
  return {
    ...{ x: p.x, y: p.y, w: p.w, h: p.h },
    ink: JSON.parse(ink),
    scraps: JSON.parse(p.scraps),
    texts: JSON.parse(texts),
  };
}
// A notebook page as its units in their order, laid out as the page lays them, each unit's parts at its place and
// what's under it right below its height: a scrap's words and the answers and replies slipped under it
// (notebookstack.js slipsUnder), each unit as tall in the layout as it and what's under it stand, a drawing under the
// unit before it (bookunits.js unitsOf). A reply's ink is its own group's, drawn by HQ, not on the picture (one on a version: over its
// frame, triedOf).
export async function unitsPage(page: number): Promise<Drawn> {
  const tops = db
    .prepare('select * from notebook_groups where page = ? and parent is null and deleted is null order by pos, id')
    .all(page) as Group[];
  const units: Unit[] = [];
  for (const g of tops) {
    // (each unit's parts read after a save's scrub under way: db.ts scrubSaved; the top groups, read before, keep the text
    // they had.)
    await latency.exclude(scrubbed());
    const parts = partsOf(g),
      under = underOf(g);
    const { h, below, hung, body } = await cardOf(g, parts, under);
    const box = boxOf(parts),
      wide = box ? Math.max(UNIT_W, box.x + box.w) : UNIT_W;
    units.push({
      ...{ id: g.id, h, w: wide, below, parts, under: below ? hung : null },
      ...{ follows: units.length > 0 && g.kind === 'drawing', card: g.kind !== 'drawing' && h > 0 },
      words: under?.text ? { ...under, x: 0, y: body } : null,
    });
  }
  // (two columns wide: the picture agents read of a page, at scale 1; what's under a unit at its foot. Every page is a
  // masonry, an old sketch page's too: its units' stored places are left unread.)
  const w = widthFor(2),
    grown = units.map(u => ({ ...u, h: u.h + u.below })),
    masonry = layout(grown, w),
    places = masonry.places.map((p, i) => ({
      ...p,
      hung: { x: p.x, y: p.y + units[i].h, w: UNIT_W, h: units[i].below },
    })),
    on = units.map((u, i) => ({ ...u, parts: shifted(u.parts, places[i].x, places[i].y), at: places[i] }));
  return {
    ...{ x: 0, y: 0, w, h: masonry.height, dotted: true },
    cards: on.flatMap(u => (u.card ? [{ x: u.at.x, y: u.at.y, w: UNIT_W, h: u.h }] : [])),
    // (each stroke with its unit, painted as the book paints it: bookrender.ts.)
    ink: on.flatMap(u => (u.parts.ink as Stroke[]).map(s => ({ ...s, unit: u.id }))),
    scraps: on.flatMap(u => u.parts.pictures),
    texts: on.flatMap(u => u.parts.texts) as Typed[],
    under: on.flatMap(u => [
      ...(u.words ? [{ ...u.words, x: u.at.x, y: u.at.y + u.words.y, onCard: true }] : []),
      ...(u.under ? [{ ...u.under, x: u.under.x + u.at.hung.x, y: u.under.y + u.at.hung.y }] : []),
    ]),
  };
}
// A unit as the grid shows it (HQ's bookunits.js cardOf): a card as tall as what's on it, a scrap's words written on it
// under its picture from body, what's under it (hung, below tall) at its foot; an agent's on its post-it, the board's
// own drawing ink on the paper. Never shown smaller, as a card past CARD.most is: agents read the page from this. One
// with nothing on it but what hangs under it (a call prototype's clip) is no card, only that (bookunits.js hung).
async function cardOf(g: Group, parts: Parts, under: Under | null) {
  const words = under?.text ? await underHigh({ ...under, slips: [], asks: [], tried: undefined }, DIR) : 0,
    body = g.kind === 'drawing' ? 0 : bodyOf(parts),
    box = boxOf(parts),
    hung = under && { ...under, text: '' },
    below =
      hung && (hung.slips?.length || hung.asks?.length || hung.tried) ? CAPTION.top + (await underHigh(hung, DIR)) : 0,
    bare = g.kind !== 'drawing' && !hasAny(parts) && !words && below > 0,
    h = bare ? 0 : Math.ceil(Math.max(body + words, CARD.least, box ? box.y + box.h + CARD.pad : 0));
  return { h, below, hung, body };
}
// What's under a unit: a scrap's words, the answers and replies slipped under it, its cards and its try's versions
function underOf(g: Group): Under | null {
  const read = shown(g),
    slips = slipsUnder(read.children)
      .map((c): Said =>
        c.kind === 'reply'
          ? { name: null, text: c.words || (c.ink.length ? 'Written reply' : '') }
          : { name: c.name, text: c.text, ...slipPicture(c.id), ...formOf(c) },
      )
      .filter(said => said.text?.trim() || said.form); // (an answer still being written has nothing to show yet)
  const text = g.kind === 'scrap' ? g.words : '',
    asks = read.asks.map(askedOf),
    tried = triedOf(read);
  return text || slips.length || asks.length || tried
    ? { ...underAt({ x: 0, y: 0, w: UNIT_W, h: 0 }, g.kind), text, slips, asks, ...(tried ? { tried } : {}) }
    : null;
}
// A unit of a notebook page: h tall and w wide (its parts', page px), with what's under it below tall (unitsPage)
type Unit = {
  id: number;
  h: number;
  w: number;
  below: number;
  parts: Parts;
  under: Under | null;
  follows: boolean;
  // (on a post-it; a scrap's words on its card, from y)
  card: boolean;
  words: Under | null;
};
// An answer's picture's file
function slipPicture(slip: number) {
  const { picture } = (db.prepare('select picture from book_slips where id = ?').get(slip) ?? {}) as {
    picture?: string | null;
  };
  return picture ? { picture } : {};
}

// ---------------------------------------------------------------- an answer's form, a unit's cards and its try's versions
type Ask = ReturnType<typeof asksOn>[number];
type Asking = { title: string; type?: string; options?: string[]; many?: boolean };
// A form clipped onto an answer as the book shows it (bookanswerreply.js formHtml), in its agent's ink: its questions,
// and once the board sent them its answers as said
function formOf(a: { by: string; form: Asking[] | null; form_answer: string[] | null }): { form?: Form } {
  if (!a.form) return {};
  const answers = a.form_answer;
  const questions = questionsOf(a.form).map((q, k) => (answers ? { ...q, answer: said(a.form![k], answers[k]) } : q));
  return { form: { color: inkOf(a.by), questions } };
}
// A card clipped under a unit as the book shows it (bookasks.js): its summary, its Choose: as chips (a notice's "Got
// it"), its questions; answered, its answer. Read without its pictures, as the slip reads it: no path as its words.
function askedOf(a: Ask): Asked {
  const c = unfoldedCard(a.body),
    choices = c.choices.length ? c.choices.map((ch: { label: string }) => ch.label) : (c.options as string[]);
  return {
    ...{ name: a.name ?? 'An agent', color: inkOf(a.agent ?? ''), answer: a.answer },
    text: ((c.summary as string[])[0] || a.title).trim(),
    choices: choices.length ? choices : a.kind === 'notice' ? ['Got it'] : [],
    questions: questionsOf(a.questions ?? []),
  };
}
// A card's questions with their chips (yes or no, or their options)
const questionsOf = (questions: Asking[]): Question[] =>
  questions.map(q => ({
    title: q.title,
    choices: q.type === 'yes-no' ? [ASKING.en.yes, ASKING.en.no] : (q.options ?? []),
  }));
// The mark of the cards and tries drawn under a page's units: '' for none
function unitsMark(page: number) {
  const tops = db
    .prepare('select * from notebook_groups where page = ? and parent is null and deleted is null order by pos, id')
    .all(page) as Group[];
  const showing = tops.flatMap(g => {
    const read = shown(g);
    return read.asks.length || read.try ? [[g.id, read.asks.map(a => [a.id, a.status]), read.try?.state]] : [];
  });
  return showing.length ? createHash('sha1').update(JSON.stringify(showing)).digest('hex').slice(0, 6) : '';
}
// A unit's try as its versions block shows it (bookversionsof.js versionsOf), each version with the board's ink on it
// (a reply sent without a frame lies on the page, not on the picture): undefined when it has neither a try nor a version
type Read = ReturnType<typeof shown>;
type Answer = Extract<Read['children'][number], { kind: 'answer' }>;
type Reply = Extract<Read['children'][number], { kind: 'reply' }>;
type Versions = {
  who: { name: string; by: string };
  versions: { v: Answer; letter: string; fate: string | null; replies: Reply[] }[];
  coming: number;
  ended: string | null;
};
function triedOf(read: Read): Tried | undefined {
  const t = versionsOf(read) as Versions | null;
  if (!t) return undefined;
  return {
    ...{ name: t.who.name, color: inkOf(t.who.by) },
    versions: t.versions.map(({ v, letter, fate, replies }) => ({
      ...{ letter, name: v.version!, text: v.text, chosen: !!v.picked, fate },
      greyed: !!v.crossed || !!fate,
      marks: replies.flatMap(r => (r.frame ? [{ frame: r.frame, ink: r.ink as Stroke[] }] : [])),
      ...slipPicture(v.id),
    })),
    coming: t.coming,
    ended: t.ended,
  };
}
