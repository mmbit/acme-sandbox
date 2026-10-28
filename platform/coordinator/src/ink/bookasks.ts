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
// A card the book can't answer, for a named reason, shows there as its title and "Answer on the desk phone": keys
// (charter rule 8: a key is typed only where HQ stores keys), photo, document and zip uploads (the desk phone's upload
// paths), an approval (what Approve grants is the desk phone's to show), files to download, and work brought back
// (review mode's answers).
import { db } from '../db.ts';
import { ceo } from '../company.ts';
import { findAgent, jobAgent } from '../jobs.ts';
import { productsOf } from '../owed.ts';
import * as cardFiles from '../cardfiles.ts';
import { BOARD } from './book.ts';
import { SHOWN } from '../shown.ts';

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
// The cards on a note: open ones the desk phone shows now (not held or for later), and answered ones, kept with it
export const asksOn = (note: number) =>
  (
    db
      .prepare(
        `select * from requests where note = ? and (status = 'answered' or (status = 'open' and ${SHOWN})) order by id`,
      )
      .all(note, new Date().toISOString()) as Row[]
  ).map(askOf);
// A card as the book shows it: its text for card.js to read, its questions for questions.js, and whether only the desk
// phone can answer it (desk)
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
    desk: deskOnly(r),
  };
}
const deskOnly = (r: Row) =>
  Boolean(r.secrets || r.approves || r.seat || r.photos || r.documents || r.zips) ||
  ['credential', 'login'].includes(r.kind) ||
  cardFiles.of(r.id).length > 0 ||
  productsOf(r.id).some(p => p.back);

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
