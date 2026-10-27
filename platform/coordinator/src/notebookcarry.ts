// The old book carried into a person's new notebook, once, as it's made (notebook.ts mine): nothing they wrote is
// lost. Each page with something on it becomes a notebook page in the order it was made: its ink in drawings (strokes
// near each other, as lines of writing join: bookwriting.ts), each typed box and picture a drawing of its own, and each
// note a scrap beside what was drawn, its snip its picture, its answers its children.
//   - A note still waiting on an open sheet becomes an open scrap, off its sheet (it goes when its page is sent), a
//     reply waiting there too; one sent, or going, is a sent scrap with its answers, and a reply sent under an answer
//     stays a reply.
//   - A page whose every scrap went is sent; one from before today with nothing open goes to the notebook's archive.
//   - Pages made after (by a screen that hadn't the Notebook yet) are carried the next time the notebook's read.
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { db } from './db.ts';
import { companyDay } from './company.ts';
import { COLUMNS, drawnOf, type Page } from './book.ts';
import { renumber, sheetRow, type Note } from './booknotes.ts';
import { unlink } from './booklinks.ts';
import { linesOf } from './bookwriting.ts';
import { DIR, type Scrap } from './pagescraps.ts';
import { pictureSize } from '../../../shared/pictures/size.ts';

// Where carried notes stand: a column this far right of what was drawn, this wide, this far apart
const COLUMN = { gap: 48, w: 360, apart: 32 };

export function carryInto(notebook: number, who: string) {
  const today = companyDay(Date.now()),
    pages = db
      .prepare(`select ${COLUMNS} from book_pages where who = ? and notebook is null order by id`)
      .all(who) as Page[];
  const { last } = db.prepare('select max(pos) last from book_pages where notebook = ?').get(notebook) as {
    last: number | null;
  };
  pages.forEach((p, i) => carryPage(p, notebook, (last ?? -1) + 1 + i, today));
}
// Whether a person has old pages still to carry (one made by a screen that hadn't the Notebook yet)
export const uncarried = (who: string) =>
  !!db.prepare('select 1 from book_pages where who = ? and notebook is null limit 1').get(who);
function carryPage(p: Page, notebook: number, pos: number, today: string) {
  const { ink, texts } = drawnOf(p.id),
    strokes = JSON.parse(ink) as unknown[],
    typed = JSON.parse(texts) as unknown[],
    scraps = JSON.parse(p.scraps) as Scrap[],
    notes = db.prepare('select * from book_notes where page = ? order by id').all(p.id) as Note[];
  for (const line of linesOf(strokes as never)) add(p, 'drawing', { ink: line });
  for (const t of typed) add(p, 'drawing', { texts: [t] });
  for (const c of scraps) add(p, 'drawing', { pictures: [{ ...c, file: copied(p.id, c.file) }] });
  let lastSent = 0,
    y = p.y;
  for (const n of notes) {
    const carried = carryNote(p, n, y);
    lastSent = Math.max(lastSent, carried.sent);
    y += carried.h + COLUMN.apart;
  }
  const open = db.prepare("select 1 from notebook_groups where page = ? and status = 'open'").get(p.id);
  db.prepare(
    `update book_pages set notebook = ?, pos = ?, send_at = ?, archived = ?, ink = '[]', strokes = 0, scraps = '[]',
    texts = '[]', picture = null where id = ?`,
  ).run(notebook, pos, !open && lastSent ? lastSent : null, Number(!!p.archived || (p.day < today && !open)), p.id);
}
// A note as a scrap of the page, at y in the page's column: its send's time if it was sent (else 0), and its height
function carryNote(p: Page, n: Note, y: number) {
  const sheet = sheetRow(n.sheet, null)!,
    waiting = n.status === 'open' && sheet.status === 'open';
  const size = n.snip && existsSync(`${DIR}/${n.snip}`) ? pictureSize(readFileSync(`${DIR}/${n.snip}`)) : null;
  const w = size ? Math.min(COLUMN.w, size.width) : 0,
    h = size ? Math.round((size.height * w) / size.width) : 0;
  const pictures: Scrap[] = size ? [{ file: copied(p.id, n.snip!), x: p.x + p.w + COLUMN.gap, y, w, h, tilt: 0 }] : [];
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
    return { sent: 0, h };
  }
  return { sent: sheet.sent ? Date.parse(sheet.sent) : Date.parse(n.created), h };
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
function add(p: Page, kind: string, parts: { ink?: unknown[]; texts?: unknown[]; pictures?: Scrap[] }, more?: Carried) {
  db.prepare(
    `insert into notebook_groups (page, parent, answers, kind, by, ink, texts, pictures, anchor, words, said, owner, status,
    note, created, updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ...[p.id, more?.parent ?? null, more?.answers ?? null, kind, more?.by ?? p.who],
    ...[JSON.stringify(parts.ink ?? []), JSON.stringify(parts.texts ?? []), JSON.stringify(parts.pictures ?? [])],
    ...[more?.anchor ?? null, more?.words ?? '', more?.said ?? null, more?.owner ?? null, more?.status ?? 'open'],
    ...[more?.note ?? null, p.created, p.updated],
  );
}
// A copy of an old picture as one of the notebook's: the old page's sweep never takes it
function copied(page: number, file: string) {
  const to = `${page}-g-${randomBytes(4).toString('hex')}.${file.endsWith('.png') ? 'png' : 'jpg'}`;
  copyFileSync(`${DIR}/${file}`, `${DIR}/${to}`);
  return to;
}
