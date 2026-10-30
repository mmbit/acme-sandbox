// A desk-phone card about a note or a page: one about a note shows in the book too. Every question the crew asks the
// board stays a card on the desk phone; one an agent files with hq ask --note <n> (a note of the board's sent to it, by
// its number in the job's brief) is also under that note's group on its Notebook page (notebookgroups.ts). The book
// answers it through the desk phone's own route (/api/requests/answer), so one answer closes both. One filed with
// --page <address> (a page with no note on it) stays on the desk phone only: the agent's sheet page it was clipped on
// went with the sheets. (the Notebook's groups)
//   - place(): the card's note and page, from hq ask's flags, checked as it's filed.
//   - asksOn(): a note's cards, as the book reads them under the note's group.
//   - card(): the desk phone's card with its place: the note's snip, number and words, and the Notebook page its group
//     is on (Open in the book), or the page's address.
// The book is Ink Studio, the design stage: nothing in it is built yet (the board, call 167). So a card for a secret, a
// step the board takes or built work stays on the desk phone only, its note's place shown there: keys and logins
// (charter rule 8: a key is typed only where HQ stores keys), photo, document and zip uploads, an approval, files to
// download, a card with steps, and finished work (a walk-through offered, work brought back).
import { db } from '../db.ts';
import { ceo } from '../company.ts';
import { endRequest, findAgent, jobAgent } from '../jobs.ts';
import { productsOf } from '../owed.ts';
import * as cardFiles from '../cardfiles.ts';
import { BOARD } from './book.ts';
import { parseCard } from '../../../hq/shell/card.js';
import { SHOWN } from '../shown.ts';
import type { Refused } from '../pagechecks.ts';

// A page's address as hq ask --page names it: a path on HQ, or a preview's whole https address (as review mode's notes
// on a preview have them)
const PAGE_URL = /^(\/|https:\/\/)[^\s]{0,1999}$/;

type Row = {
  id: number;
  created: string;
  agent: string | null;
  kind: string;
  title: string;
  body: string;
  status: string;
  answer: string | null;
  answered: string | null;
  secrets: string | null;
  approves: string | null;
  seat: string | null;
  photos: string | null;
  documents: string | null;
  zips: string | null;
  questions: string | null;
  walk: number;
  address: string | null;
  note: number | null;
  page: string | null;
};
type NoteRow = {
  id: number;
  sheet: number;
  page: number;
  n: number;
  anchor: string;
  words: string;
  snip: string | null;
};

// hq ask's --note <n> and --page <address>: { note: the book note's id, page }, or what's wrong (worded for the agent).
// A note is the asker's own: one its job holds, as hq answer reads it (the sheet's owner's, or, routed by the CEO from a
// sheet nobody owns, the maker's)
export function place(b: { note?: unknown; page?: unknown }, agent: string) {
  if (b.note == null && b.page == null) return { note: null, page: null };
  if (b.note != null && b.page != null)
    return 'a card is about one place: --note for a note of the board’s, or --page for a page without one';
  if (b.page != null)
    return typeof b.page === 'string' && PAGE_URL.test(b.page)
      ? { note: null, page: b.page }
      : '--page is a page’s address: a path on HQ (/...) or a preview’s https address';
  const found = db
    .prepare(
      `select n.id, r.job from book_notes n join book_sheets s on s.id = n.sheet join review_notes r on r.id = n.review
      where n.review = ? and s.who = ?`,
    )
    .get(Number(b.note), BOARD) as { id: number; job: number | null } | undefined;
  if (!found)
    return `--note ${String(b.note)} isn't one of the board's book notes: the number a note has in a job's brief`;
  return found.job && jobAgent(found.job) === agent
    ? { note: found.id, page: null }
    : `--note ${String(b.note)} is a note the board sent to someone else: ask about one of the notes sent to you`;
}
// ---------------------------------------------------------------- the book's read
// The cards on a note the book shows: open ones the desk phone shows now (not held or for later), and answered ones,
// kept with it; none for a secret, a step or built work (deskOnly)
export const asksOn = (note: number) =>
  (
    db
      .prepare(
        `select * from requests where note = ? and (status = 'answered' or (status = 'open' and ${SHOWN})) order by id`,
      )
      .all(note, new Date().toISOString()) as Row[]
  )
    .filter(r => !deskOnly(filed(r)))
    .map(askOf);
// The card an agent's design ask is (its group's request: askpages.ts), as the book shows it under its scrap: none once
// withdrawn
export const asksBy = (request: number) =>
  (
    db
      .prepare(`select * from requests where id = ? and (status = 'answered' or (status = 'open' and ${SHOWN}))`)
      .all(request, new Date().toISOString()) as Row[]
  ).map(askOf);
export const askShown = (request: number) => asksBy(request).length > 0;
// The board deleted an agent's design ask from its book. An open card leaves the desk phone with it, as HQ ends a card,
// so the book and the desk phone never disagree about it. An answered card stays as the board answered it.
export function askDeleted(request: number) {
  const { status } = db.prepare('select status from requests where id = ?').get(request) as { status: string };
  if (status === 'open') endRequest(request, 'the board deleted it from its book');
}
// Undo of that delete, once its card is gone: the scrap stays gone with it
export const ASK_GONE: Refused = [409, 'this ask left the desk phone with its card when it was deleted', 'askGone'];
// A card as the book shows it: its text for card.js to read, its questions for questions.js
function askOf(r: Row) {
  return {
    id: r.id,
    agent: r.agent,
    name: r.agent ? (findAgent(r.agent)?.name ?? r.agent) : null,
    kind: r.kind,
    title: r.title,
    body: r.body,
    questions: r.questions ? JSON.parse(r.questions) : null,
    page: r.page,
    status: r.status,
    answer: r.status === 'answered' ? r.answer : null,
    answered: r.status === 'answered' ? r.answered : null,
  };
}
// What on a card keeps it off the book, as the agent would name it, or null: hq ask --book refuses such a card
// (askpages.ts), and the book shows no filed one under its note
export function deskOnly(c: DeskCard) {
  if (c.secrets || c.seat || ['credential', 'login'].includes(c.kind)) return 'A card for keys or a login';
  if (c.approves || c.kind === 'approval') return 'An approval (money, a launch, going public)';
  if (c.uploads) return 'A card asking for uploads';
  if (c.files) return 'A card with files to download';
  if (c.walk || c.back) return 'Finished work (a walk-through, or work brought back)';
  if (c.address) return 'An address card';
  // (steps the board takes elsewhere: the card's Steps: checklist, or a web task done with Claude)
  const parsed = parseCard(c.body);
  if (parsed.steps.length > 0 || parsed.claude) return 'A card with steps the board takes in another system';
  return null;
}
// A card's fields deskOnly reads: hq ask's as it's filed, or a filed card's row (filed)
export type DeskCard = {
  kind: string;
  body: string;
  secrets: unknown;
  seat: unknown;
  approves: unknown;
  address: unknown;
  walk: unknown;
  uploads: boolean;
  files: boolean;
  back: boolean;
};
const filed = (r: Row): DeskCard => ({
  ...r,
  uploads: Boolean(r.photos || r.documents || r.zips),
  files: cardFiles.of(r.id).length > 0,
  back: productsOf(r.id).some(p => p.back),
});

// ---------------------------------------------------------------- the desk phone's read
// GET /api/requests' card with its place: the note (its snip, its number on its sheet, its owner, its words, its page's
// address, and the Notebook page its group is on: Open in the book) or the page's address alone
export function card<T extends Pick<Row, 'agent' | 'created' | 'note' | 'page'>>(r: T) {
  if (r.note == null && r.page == null) return r;
  if (r.page != null) return { ...r, place: { url: r.page, page: null, notebook: null, note: null } };
  const n = db.prepare('select * from book_notes where id = ?').get(r.note) as NoteRow | undefined;
  if (!n) return r;
  const sheet = db.prepare('select owner from book_sheets where id = ?').get(n.sheet) as { owner: string | null },
    // (the note's group's page: a note carried from the old book's day pages has its group on a Notebook page)
    on = db
      .prepare(
        `select p.id, p.notebook from notebook_groups g join book_pages p on p.id = g.page
        where g.note = ? and g.deleted is null`,
      )
      .get(n.id) as { id: number; notebook: number } | undefined;
  return {
    ...r,
    place: {
      url: (JSON.parse(n.anchor) as { url: string }).url,
      page: on?.id ?? null,
      notebook: on?.notebook ?? null,
      note: n.id,
      n: n.n,
      // (the sheet of pages nobody owns goes to the CEO)
      owner: sheet.owner ?? ceo(),
      words: n.words,
      snip: n.snip ? `/api/book/snip?id=${n.id}` : null,
    },
  };
}
