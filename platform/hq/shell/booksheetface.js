// A face in the rail and its sheet in the book (booksheet.js's): a face tapped turns the book to their sheet with a turn
// of the leaf; the small plane by it hands the sheet shown over, or takes a send in its seconds back; the face of the
// sheet shown marked.
import { markHere } from './bookrail.js';
import { planeSheet, whose } from './booksheetplace.js';
import { handOver, undoNow } from './bookplane.js';
import { turn } from './bookflip.js';
import { createPage, loadPage } from './bookdata.js';
import { newPageSize } from './bookrow.js';

// sh: booksheet.js's sheets ({ book, hooks, dev, sheets, on, ceo(), view(id) })
export function mountFaces(sh) {
  document.addEventListener('book:face', e => openSheetOf(sh, e.detail.owner ?? sh.ceo()));
  document.addEventListener('book:give', e => given(sh, e.detail));
  const here = () => markHere(sheetShown(sh)?.page.owner ?? null);
  document.addEventListener('book:turn', here);
  document.addEventListener('book:whose', here);
}

// The page the book shows when it's a sheet page of the board's own book, or null
function sheetShown(sh) {
  const v = sh.book.who ? null : sh.book.views[sh.book.cur];
  return v?.page.kind === 'sheet' && v.page.id ? v : null;
}
const sheetView = (sh, owner) =>
  sh.book.who ? null : sh.book.views.find(v => v.page.kind === 'sheet' && v.page.owner === owner && v.page.id);

// An agent's sheet, turned to: in the day shown, with a turn of the leaf; elsewhere, the leaf turns and under it the
// book opens today at their sheet page (made when their notes have none yet), or, an answer all they have to read, at
// the page its note is on. Never the day read again in sight: that was a blink with nothing opened.
async function openSheetOf(sh, owner) {
  const v = sheetView(sh, owner);
  if (v) return sh.hooks.show(v.page.id);
  await turn(sh.book.paper, { midway: () => elsewhere(sh, owner) });
}
async function elsewhere(sh, owner) {
  const waiting = sh.sheets.open.some(
    s => !s.page && whose(s, sh.ceo()) === owner && s.notes.some(n => n.status === 'open'),
  );
  if (waiting) {
    if (sh.book.day !== sh.book.today || sh.book.who) await sh.hooks.open();
    const page =
      sheetView(sh, owner)?.page ??
      (await createPage(sh.dev, { kind: 'sheet', owner, url: '/', ...newPageSize(sh.book.size) }).catch(e =>
        console.error('[hq] The book: a sheet page can’t be made:', e),
      ));
    return page && sh.hooks.open(undefined, page.id);
  }
  const note = [...sh.sheets.open, ...sh.sheets.sent]
    .filter(s => whose(s, sh.ceo()) === owner)
    .flatMap(s => s.notes)
    .find(n => n.slips?.some(slip => !slip.ticked));
  if (!note) return;
  const page = sh.view(note.page)?.page ?? (await loadPage(sh.dev, note.page).catch(() => null));
  if (page) await sh.hooks.open(page.day, page.id);
}

// The plane by a face tapped (bookrail.js book:give): a send in its seconds taken back, or the sheet shown handed over
// to that face's agent (id), its notes folding into the plane
function given(sh, { id, sending }) {
  const v = sheetShown(sh);
  if (sending) return undoNow(sh, v, sending);
  if (v?.page.owner !== id) return;
  const sheet = planeSheet(sh.sheets, v.page, sh.ceo(), sh.on.get(v.page.id) ?? []);
  if (sheet?.status === 'open') handOver(sh, v, sheet);
}
