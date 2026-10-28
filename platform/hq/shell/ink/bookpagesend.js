// A Notebook page sent whole (knowledge/notes/platform/notebook.md): the foot row's Send, and its groups go in 10
// seconds, each as a note to the agent whose work it was cut from (or as the routing check decides). Till then Undo
// takes it back, from a toast or the book's Undo. The fresh page the send made is turned to at once. A page sending or
// sent is stamped at its head, its time once it's gone, and its own groups are read-only (booksave.js); its answers
// and replies still come and go.
import { esc } from '../../util.js';
import { toast } from '../hud.js';
import { stamp } from './bookpaper.js';
import { keep } from './bookedit.js';
import { said, saved, shut } from './booksave.js';
import { sendPage, undoSend } from './notebookdata.js';
import { viewOf } from './bookview.js';

// how long a send waits to go (notebooksend.ts SEND_MS), and a little after, to read the page once it's gone
const SEND_MS = 10_000,
  AFTER_MS = 600;

// book: bookpages.js's. hooks: { pagesAgain() (the notebook's pages read again, a promise), show(id) (a page turned
// to) }
export async function sendShown(book, hooks) {
  const v = viewOf(book),
    page = v?.page;
  if (!page || shut(page)) return;
  try {
    await saved(book, page);
  } catch {
    return; // (the save that failed said why on the page: the store's older groups don't go in its place)
  }
  let answer;
  try {
    answer = await sendPage(book.dev, page.id);
  } catch (e) {
    return said(book, page, e.message);
  }
  const step = { page, undo: () => takeBack(book, page, hooks), redo: null };
  // (what was drawn on it before can't be undone now: its groups are sent)
  keep(book.steps, s => s.page !== page);
  book.steps.push(step);
  went(book, page, answer);
  toast('<b>Sent.</b> It goes in 10 seconds: tap to undo', () => {
    if (book.steps.includes(step)) keep(book.steps, s => s !== step);
    step.undo();
  });
  setTimeout(() => hooks.pagesAgain().then(() => stamped(book, page)), SEND_MS + AFTER_MS);
  await hooks.pagesAgain();
  const fresh = book.views.map(x => x.page).filter(p => !shut(p) && !p.archived);
  const to = fresh.sort((a, b) => b.created.localeCompare(a.created))[0];
  if (to) hooks.show(to.id);
}
// A send taken back in its seconds: the page open again and turned back to
async function takeBack(book, page, hooks) {
  try {
    went(book, page, await undoSend(book.dev, page.id));
  } catch (e) {
    return toast(esc(e.message));
  }
  await hooks.pagesAgain();
  hooks.show(page.id);
}
// A page as the store says it is after a send or its undo: its stamp, and its groups' clips
function went(book, page, answer) {
  Object.assign(page, { sending: answer.sending, sent: answer.sent, updated: answer.updated });
  book.groups?.drawn(page);
  stamped(book, page, true);
}
// The stamp at a page's head: Sending while it waits, Sent and its time once gone, none on an open page (el: its view's,
// one not yet in the book's)
export function stamped(book, page, fresh = false, el = book.views.find(x => x.page === page)?.el) {
  const node = el?.querySelector('[data-slot=stamp]');
  if (!node) return;
  const words = page.sent ? `Sent ${timeOf(page.sent)}` : page.sending ? 'Sending' : '';
  if (!words) {
    node.textContent = '';
    return node.classList.remove('bk-stamped');
  }
  if (fresh || node.textContent !== words) stamp(node, words);
}
const timeOf = at =>
  new Date(at).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
