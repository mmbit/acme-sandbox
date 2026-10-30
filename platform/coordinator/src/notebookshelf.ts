// What the shelf shows of a notebook besides its name (notebook.ts notebookOf): its cover and its news.
//   - A cover: the picture the board gave it (POST /api/notebooks/cover), kept in the book's files as
//     `nb<id>-c-<random>`, served only to the board; a project's book without one shows its project's cover
//     (projects.yaml). None: HQ draws a quiet one (bookshelfbooks.js).
//   - Its news: the agents' answers in it since the board last read it (seen: a read of its pages or of a page's
//     groups).
// Reads only the tables, never notebook.ts, which reads it as it loads.
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { db, lacks, once } from './db.ts';
import { projects } from './company.ts';
import { publish } from './events.ts';
import { BOARD } from './ink/book.ts';
import { dataUrlPicture, isRefused, type Refused } from './pagechecks.ts';
import { DIR, notFound, serveFile, tooBig } from './pagescraps.ts';
import { keepFile } from './uploads.ts';

// The board's own notebook's name, everywhere the board reads it
export const MY_JOURNAL = 'My journal';
const COVER = /^nb(\d+)-c-[0-9a-f]{8}\.(png|jpg)$/;

type Row = {
  id: number;
  kind: string;
  project: string | null;
  cover: string | null;
  seen: string | null;
  created: string;
};

// The notebooks table's cover and seen where an older one lacks them (notebook.ts makes the table, then calls this),
// and the board's own notebook renamed My journal. It runs while notebook.ts loads: it reads nothing but db.ts's.
export function shelfColumns() {
  for (const column of ['cover', 'seen'])
    if (lacks('notebooks', column)) db.exec(`alter table notebooks add column ${column} text`);
  once('2026-10-30-my-journal', () => {
    db.exec('update notebooks set seen = updated');
    db.exec("update notebooks set name = 'My journal' where kind = 'mine' and name = 'My Notebook'");
  });
}

// A notebook's cover (an address, or null: drawn) and its new answers, as the shelf reads them
export const shelfOf = (n: Row) => ({
  cover: n.cover
    ? `/api/notebooks/cover?id=${n.id}&v=${encodeURIComponent(n.cover)}`
    : (n.project && projects().covers[n.project]) || null,
  news: newAnswers(n.id, n.seen ?? n.created),
});
// The agents' answers in a notebook's groups (on a group, or on the note it went as) since a time
const newAnswers = (notebook: number, since: string) =>
  (
    db
      .prepare(
        `select count(*) n from book_slips s where s.created > $since and (
          s.grp in (select g.id from notebook_groups g join book_pages p on p.id = g.page where p.notebook = $notebook)
          or s.note in (select g.note from notebook_groups g join book_pages p on p.id = g.page
            where p.notebook = $notebook and g.note is not null))`,
      )
      .get({ notebook, since }) as { n: number }
  ).n;

// The board read a notebook (its pages), or a page of one (its groups): its answers so far are seen
export const seenNotebook = (notebook: number) =>
  db.prepare('update notebooks set seen = ? where id = ?').run(new Date().toISOString(), notebook);
export const seenPage = (page: number) =>
  db
    .prepare('update notebooks set seen = ? where id = (select notebook from book_pages where id = ?)')
    .run(new Date().toISOString(), page);

// POST /api/notebooks/cover { id, picture }: a picture (a PNG or JPEG data URL) for a notebook's cover, the one before
// it thrown away. The notebook as the shelf lists it: { id, cover }.
export function setCover(b: any, who = BOARD): Refused | 404 | { id: number; cover: string } {
  const n = row(Number(b?.id), who);
  if (!n) return 404;
  const p = dataUrlPicture(b.picture);
  if (isRefused(p)) return p;
  const big = tooBig(p.clean);
  if (big) return big;
  const file = `nb${n.id}-c-${randomBytes(4).toString('hex')}.${p.type === 'image/png' ? 'png' : 'jpg'}`;
  keepFile(`${DIR}/${file}`, p.clean);
  db.prepare('update notebooks set cover = ? where id = ?').run(file, n.id);
  if (n.cover) rmSync(`${DIR}/${n.cover}`, { force: true });
  publish({ type: 'book', agent: BOARD, text: 'notebook' });
  return { id: n.id, cover: shelfOf({ ...n, cover: file }).cover! };
}
// GET /api/notebooks/cover?id=: a notebook's cover, the board's only
export function serveCover(req: IncomingMessage, res: ServerResponse, who = BOARD) {
  const n = row(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('id')), who);
  if (!n?.cover || !COVER.test(n.cover) || !existsSync(`${DIR}/${n.cover}`)) return notFound(res);
  serveFile(res, n.cover);
}
const row = (id: number, who: string) =>
  (Number.isInteger(id) && id > 0
    ? db.prepare('select * from notebooks where id = ? and who = ?').get(id, who)
    : undefined) as (Row & { who: string }) | undefined;
