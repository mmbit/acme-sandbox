// An agent's design ask in the board's book: one hq ask --book <project | journal> files the desk-phone card and puts it
// as a scrap on the Asks page of that project's book (My journal's for HQ, or work with no project yet), linked: the
// scrap shows the card (bookasks.ts asksBy), and an answer in either place is the card's answer, so it closes both. A card
// the agent withdraws takes its scrap with it, and a scrap the board deletes takes its open card (bookasks.ts
// askDeleted). The book is the design stage: keys, steps in other systems, money, launches and uploads stay on the desk
// phone, refused here so no agent has to remember the line (plan, piece 5).
//   - A project's book is the CEO's to make (hq projectbook), one per project, on the board's shelf; its cover counts
//     its asks (notebook.ts asksCount). An ask for a project with no book yet lands in My journal, which the answer says.
//   - A notebook's Asks page is a page of kind 'asks', made with its first ask; new groups of the board's never land
//     there (notebookstack.js landingPage).
import { db } from '../db.ts';
import { anyProject, noProject } from '../names.ts';
import { BOARD } from './book.ts';
import { companyDay } from '../company.ts';
import { deskOnly, type DeskCard } from './bookasks.ts';
import { changed, endOf, makeNotebook, mine, notebookRow, type Notebook } from '../notebook.ts';
import { addPicture, addWords } from '../notebookscraps.ts';
import { spotOf } from './askspot.ts';
import { roundOf } from '../notebookrounds.ts';
import { isRefused, type Refused } from '../pagechecks.ts';

// What hq ask --book takes for the board's own notebook
export const JOURNAL = 'journal';
const ASKS_LABEL = 'Asks';
const NEW_PAGE = { w: 1200, h: 1600 };

// ---------------------------------------------------------------- project books
// POST /api/agent/projectbook { project, name? } (the CEO's): the project's book on the board's shelf, made if there's
// none, named for the project unless a name is given; an archived one comes back on the shelf
export function makeProjectBook(b: any) {
  const id = String(b?.project ?? ''),
    project = anyProject(id);
  if (!project || project.status !== 'open') return [400, noProject(id)] as Refused;
  const name = b.name == null ? project.name : String(b.name).trim();
  if (!name || name.length > 60) return [400, 'a book’s name is 1 to 60 characters'] as Refused;
  const found = projectBook(id);
  if (found) {
    db.prepare('update notebooks set archived = 0, name = ?, updated = ? where id = ?').run(
      name,
      new Date().toISOString(),
      found.id,
    );
    changed(found.id, null);
    return { id: found.id, name, project: id, made: false };
  }
  const made = makeNotebook(BOARD, 'project', name);
  db.prepare('update notebooks set project = ? where id = ?').run(id, made);
  changed(made, null);
  return { id: made, name, project: id, made: true };
}
const projectBook = (project: string) =>
  db.prepare("select * from notebooks where who = ? and kind = 'project' and project = ?").get(BOARD, project) as
    Notebook | undefined;

// ---------------------------------------------------------------- an ask
// hq ask's --book: the notebook its scrap goes in ({ notebook, name, fell: true when the project has no book yet and it
// goes in My journal, spot: the thing on a page it's about, ringed, with --at and --spot }), undefined for a card without
// one, or what's wrong (worded for the agent)
export async function bookOf(b: any) {
  if (b?.book == null) return b?.spot == null ? undefined : '--at and --spot go with --book: a design ask in the book';
  const book = bookNamed(b);
  if (typeof book === 'string' || b.spot == null) return book;
  const spot = await spotOf(b.spot);
  return typeof spot === 'string' ? `--at and --spot: ${spot}` : { ...book, spot };
}
// (--at, --spot: askspot.ts.)
type Book = {
  notebook: number;
  name: string;
  fell: boolean;
  spot?: Exclude<Awaited<ReturnType<typeof spotOf>>, string>;
};
function bookNamed(b: any): Book | string {
  if (b.note != null || b.page != null)
    return 'a card is about one place: --book for a design ask in the board’s book, --note for a note, --page for a page';
  const asked = String(b.book);
  const desk = deskOnly(asFiled(b));
  if (desk)
    return `${desk} stays on the desk phone only: the book is for design (a sketch, a choice, a question about how something looks or works). File it without --book.`;
  if (asked === JOURNAL) return { notebook: mine(BOARD).id, name: mine(BOARD).name, fell: false };
  // (a guest's book by its number, as the round or the guest's invite names it. A review round takes asks until the
  // board closes it, and its close warns of the open ones. One guest's invited book takes them always. The board
  // forwards the card's Share part to the guest.)
  if (/^[0-9]+$/.test(asked)) {
    const book = notebookRow(Number(asked), BOARD);
    const takesAsks = book?.kind === 'invited' || (book?.kind === 'round' && !roundOf(book.id)?.closed);
    if (!book || !takesAsks) return `--book ${asked}: no guest's book or open review round's`;
    return { notebook: book.id, name: book.name, fell: false };
  }
  const project = anyProject(asked);
  if (!project || project.status !== 'open') return `--book is a project or ${JOURNAL}: ${noProject(asked)}`;
  const book = projectBook(asked);
  if (!book) return { notebook: mine(BOARD).id, name: mine(BOARD).name, fell: true };
  return { notebook: book.id, name: book.name, fell: false };
}
// hq ask's fields as bookasks.ts deskOnly reads a card
function asFiled(b: any) {
  const any = (v: unknown) => Array.isArray(v) && v.length > 0;
  return {
    ...b,
    kind: String(b.kind),
    body: String(b.body ?? ''),
    uploads: any(b.photos) || any(b.documents) || any(b.zips),
    files: any(b.files),
    back: any(b.back),
  } as DeskCard;
}
// The filed card as a scrap of the agent's on the notebook's Asks page, its title the scrap's words, its card under it.
// An archived project book comes back on the shelf with it.
// With a spot, the scrap is its ringed shot, the title its words and the spot its anchor (askspot.ts).
export function placeAsk(request: number, book: Book, agent: string, title: string) {
  const notebook = book.notebook;
  db.prepare("update notebooks set archived = 0 where id = ? and kind = 'project'").run(notebook);
  const page = asksPage(notebook);
  const g = book.spot
    ? addPicture(page, agent, book.spot.shot, { anchor: book.spot.anchor, words: title, said: 'typed', owner: agent })
    : addWords(page, agent, title, { owner: agent });
  // (a title the card's checks let through always fits a scrap: a refusal here is our bug)
  if (isRefused(g)) throw new Error(`Asks page ${page.id}: the ask's scrap was refused: ${g[1]}`);
  db.prepare('update notebook_groups set request = ? where id = ?').run(request, g.id);
  changed(notebook, page.id);
  return { page: page.id, group: g.id };
}
// A notebook's Asks page of a person's (the board's, or a guest's in a book they're in: bookassign.ts): its newest one
// not sent or archived, made if there's none
export function asksPage(notebook: number, who = BOARD) {
  const found = db
    .prepare(
      `select id from book_pages where notebook = ? and who = ? and kind = 'asks' and archived = 0 and send_at is null
      order by id desc limit 1`,
    )
    .get(notebook, who) as { id: number } | undefined;
  const id = found?.id ?? newAsksPage(notebook, who);
  return db.prepare('select * from book_pages where id = ?').get(id) as Parameters<typeof addWords>[0];
}
function newAsksPage(notebook: number, who: string) {
  const now = new Date().toISOString();
  return Number(
    db
      .prepare(
        `insert into book_pages (who, day, kind, label, title_by, created, updated, w, h, notebook, pos)
        values (?, ?, 'asks', ?, 'agent', ?, ?, ?, ?, ?, ?)`,
      )
      .run(who, companyDay(Date.now()), ASKS_LABEL, now, now, NEW_PAGE.w, NEW_PAGE.h, notebook, endOf(notebook))
      .lastInsertRowid,
  );
}
