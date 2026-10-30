// The old book carried into a person's new notebook, once, as it's made (notebook.ts mine): nothing they wrote is
// lost. Each page with something on it becomes a notebook page in the order it was made, of scrap units: its ink in
// drawings (strokes near each other, as lines of writing join: bookwriting.ts), each typed box and picture a drawing of
// its own, in the order they read on it, and then each note a scrap, its snip its picture, its answers its children.
//   - A note still waiting on an open sheet becomes an open scrap, off its sheet (it goes when its page is sent), a
//     reply waiting there too; one sent, or going, is a sent scrap with its answers, and a reply sent under an answer
//     stays a reply.
//   - A page whose every scrap went is sent; one from before today with nothing open goes to the notebook's archive.
//   - Pages made after (by a screen that hadn't the Notebook yet) are carried the next time the notebook's read, and so
//     is a note written the old way since (review mode's on a preview or HQ, till the pin flow writes scraps) onto a page
//     already carried: an open scrap, the current page's last, as a new scrap lands.
//     (the late notes)
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { db } from './db.ts';
import { companyDay } from './company.ts';
import { COLUMNS, drawnOf, type Page } from './ink/book.ts';
import { renumber, sheetRow, type Note } from './ink/booknotes.ts';
import { unlink } from './ink/booklinks.ts';
import { linesOf } from './ink/bookwriting.ts';
import { DIR, type Scrap } from './pagescraps.ts';
import { inReadingOrder, lastPos } from './notebookorder.ts';
import { boxOf } from '../../hq/shell/ink/notebookstack.js';
import { UNIT_W, roomFor, unitOf } from '../../hq/shell/ink/scrapunit.js';
import { pictureSize } from '../../../shared/pictures/size.ts';

// end: the place after the notebook's last page (notebook.ts endOf). current(): the notebook's current page, made if
// there's none (notebook.ts currentPage). Returns the page late notes went on, or null.
export function carryInto(notebook: number, who: string, end: number, current: () => number) {
  const today = companyDay(Date.now()),
    pages = db
      .prepare(`select ${COLUMNS} from book_pages where who = ? and notebook is null order by id`)
      .all(who) as Page[];
  pages.forEach((p, i) => carryPage(p, notebook, end + i, today));
  const late = lateNotes(who);
  if (!late.length) return null;
  const p = db.prepare(`select ${COLUMNS} from book_pages where id = ?`).get(current()) as Page;
  for (const n of late) carryNote(p, n);
  return p.id;
}
// Whether a person has something still to carry: an old page (one made by a screen that hadn't the Notebook yet), or a
// note waiting on an open sheet on a page already carried
export const uncarried = (who: string) =>
  !!db.prepare('select 1 from book_pages where who = ? and notebook is null limit 1').get(who) ||
  lateNotes(who).length > 0;
// The notes written the old way onto pages already carried, still waiting on an open sheet (not a call's, not a
// notebook send's)
const lateNotes = (who: string) =>
  db
    .prepare(
      `select n.* from book_notes n join book_sheets s on s.id = n.sheet join book_pages p on p.id = n.page
      where s.who = ? and s.status = 'open' and s.notebook_page is null and n.status = 'open' and p.notebook is not null
      order by n.id`,
    )
    .all(who) as Note[];
function carryPage(p: Page, notebook: number, pos: number, today: string) {
  const lastSent = carryParts(p, db.prepare('select * from book_notes where page = ? order by id').all(p.id) as Note[]);
  const open = db.prepare("select 1 from notebook_groups where page = ? and status = 'open'").get(p.id);
  db.prepare('update book_pages set notebook = ?, pos = ?, send_at = ?, archived = ? where id = ?').run(
    notebook,
    pos,
    !open && lastSent ? lastSent : null,
    Number(!!p.archived || (p.day < today && !open)),
    p.id,
  );
}
// What's on a page in the old book's columns as groups of the same page, the columns emptied: its ink, typed words and
// pictures, and of its notes those given. The time of the last of them sent, else 0
export function carryParts(p: Page, notes: Note[]) {
  const { ink, texts } = drawnOf(p.id),
    strokes = JSON.parse(ink) as unknown[],
    typed = JSON.parse(texts) as unknown[],
    scraps = JSON.parse(p.scraps) as Scrap[];
  const drawn = [
    ...linesOf(strokes as never).map(line => ({ ink: line })),
    ...typed.map(t => ({ texts: [t] })),
    ...scraps.map(c => ({ pictures: [{ ...c, file: copied(p.id, c.file) }] })),
  ].map((parts, id) => ({ id, parts, box: boxOf(parts) }));
  for (const { parts } of inReadingOrder(drawn)) add(p, 'drawing', parts);
  let lastSent = 0;
  for (const n of notes) lastSent = Math.max(lastSent, carryNote(p, n));
  db.prepare(
    "update book_pages set ink = '[]', strokes = 0, scraps = '[]', texts = '[]', picture = null where id = ?",
  ).run(p.id);
  return lastSent;
}
// A note as a scrap of the page, its last: its send's time if it was sent, else 0
function carryNote(p: Page, n: Note) {
  const sheet = sheetRow(n.sheet, null)!,
    waiting = n.status === 'open' && sheet.status === 'open';
  const size = n.snip && existsSync(`${DIR}/${n.snip}`) ? pictureSize(readFileSync(`${DIR}/${n.snip}`)) : null;
  const w = size ? Math.min(UNIT_W, size.width) : 0,
    h = size ? Math.round((size.height * w) / size.width) : 0;
  const pictures: Scrap[] = size ? [{ file: copied(p.id, n.snip!), x: 0, y: 0, w, h, tilt: 0 }] : [];
  const answered = waiting || n.answers === null ? undefined : repliedUnder(n.answers);
  add(
    p,
    answered ? 'reply' : 'scrap',
    { pictures },
    {
      by: n.by,
      anchor: n.anchor,
      words: n.words,
      said: n.said,
      owner: sheet.owner,
      status: waiting ? 'open' : 'sent',
      note: waiting ? null : n.id,
      parent: answered ?? null,
      answers: answered ? n.answers : null,
    },
  );
  if (waiting) {
    db.prepare('delete from book_notes where id = ?').run(n.id);
    unlink(n.id);
    renumber(n.sheet);
    return 0;
  }
  return sheet.sent ? Date.parse(sheet.sent) : Date.parse(n.created);
}
// The carried group a reply's answer is on
const repliedUnder = (slip: number) =>
  (
    db
      .prepare(
        'select g.id from notebook_groups g join book_slips s on s.note = g.note where s.id = ? and g.parent is null',
      )
      .get(slip) as { id: number } | undefined
  )?.id;
type Carried = {
  by: string;
  anchor: string;
  words: string;
  said: string | null;
  owner: string | null;
  status: string;
  note: number | null;
  parent: number | null;
  answers: number | null;
};
// A carried group: a unit, its page's last, unless it's a reply
function add(p: Page, kind: string, given: { ink?: unknown[]; texts?: unknown[]; pictures?: Scrap[] }, more?: Carried) {
  const by = more?.by ?? p.who,
    parent = more?.parent ?? null;
  const unit = parent === null ? unitOf({ ink: [], texts: [], pictures: [], ...given }, roomFor(by, p.who)) : null,
    parts = unit?.parts ?? { ink: [], texts: [], pictures: [], ...given };
  db.prepare(
    `insert into notebook_groups (page, parent, answers, kind, by, ink, texts, pictures, anchor, words, said, owner, status,
    note, created, updated, pos, h) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ...[p.id, parent, more?.answers ?? null, kind, by],
    ...[JSON.stringify(parts.ink), JSON.stringify(parts.texts), JSON.stringify(parts.pictures)],
    ...[more?.anchor ?? null, more?.words ?? '', more?.said ?? null, more?.owner ?? null, more?.status ?? 'open'],
    ...[more?.note ?? null, p.created, p.updated, unit ? lastPos(p.id) + 1 : null, unit?.h ?? null],
  );
}
// A copy of an old picture as one of the notebook's: the old page's sweep never takes it
function copied(page: number, file: string) {
  const to = `${page}-g-${randomBytes(4).toString('hex')}.${file.endsWith('.png') ? 'png' : 'jpg'}`;
  copyFileSync(`${DIR}/${file}`, `${DIR}/${to}`);
  return to;
}
