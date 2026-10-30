// A Notebook page sent whole (knowledge/notes/platform/notebook.md): Send at the top of the controls' stack, and its groups go in 10 seconds, each as a note to the agent whose work it was cut from
// (or as the routing check decides). Till then Undo takes it back, from a toast or the book's Undo. The page sent is
// stamped, folds into a paper plane and flies off, leaving the book on the page under it: the next, or the fresh page
// the store made after the last. A page sending or sent wears a red rubber stamp at its head,
// Sent and the day and time once it's gone, still wet till then, and its own groups are read-only (booksave.js); its
// answers and replies still come and go. (the plane and the stamp)
import { esc } from '../../util.js';
import { toast } from '../toast.js';
import { plane, stamp } from './bookpaper.js';
import { picture } from './bookflip.js';
import { keep } from './bookedit.js';
import { said, saved, shut } from './booksave.js';
import { sendPage, undoSend } from './notebookdata.js';
import { viewOf } from './bookview.js';
import { scope, word } from './bookscope.js';

// how long a send waits to go (notebooksend.ts SEND_MS), and a little after, to read the page once it's gone; the
// stamp's press before the page folds
const SEND_MS = 10_000,
  AFTER_MS = 600,
  PRESS_MS = 260;

// book: bookpages.js's. hooks: { pagesAgain() (the notebook's pages read again, a promise), show(id) (a page turned
// to), under(id) (a page shown at once, under what covers the paper) }
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
  toast(word('<b>Sent.</b> It goes in 10 seconds: tap to undo'), () => {
    if (book.steps.includes(step)) keep(book.steps, s => s !== step);
    step.undo();
  });
  setTimeout(() => hooks.pagesAgain().then(() => stamped(book, page)), SEND_MS + AFTER_MS);
  await flown(book, page, hooks);
}
// The page sent, stamped, folds into a plane and flies off, the page after it shown under it at once (after the last,
// the fresh page the store made, once read). Left as it is if the board turned away meanwhile.
async function flown(book, page, hooks) {
  const after = () => book.views[book.views.findIndex(v => v.page === page) + 1];
  const read = after() ? null : hooks.pagesAgain();
  await new Promise(r => setTimeout(r, PRESS_MS));
  await read;
  const next = after();
  if (!next || viewOf(book)?.page !== page) return;
  plane(book.desk.getBoundingClientRect(), picture(book.desk));
  hooks.under(next.page.id);
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
// The stamp at a page's head: a red rubber stamp, Sent, as the overview's tiles wear it (bookshelftiles.js), with
// its day and time once it's gone, its ink still wet till then; none on an open page (el: its view's, one not yet in
// the book's). Pressed down as the page is sent (fresh).
export function stamped(book, page, fresh = false, el = book.views.find(x => x.page === page)?.el) {
  const node = el?.querySelector('[data-slot=stamp]');
  if (!node) return;
  // (a call's notes page goes in and to nobody: no stamp.)
  if ((!page.sent && !page.sending) || page.kind === 'call') {
    node.replaceChildren();
    return node.classList.remove('bk-stamped', 'bk-stamp-wet');
  }
  const time = page.sent ? timeOf(page.sent) : '',
    when = time.toLocaleUpperCase();
  node.classList.toggle('bk-stamp-wet', !page.sent);
  if (!fresh && node.firstChild && node.dataset.when === when) return;
  node.dataset.when = when;
  const label = time ? word('Sent {time}', { time }) : word('Sent');
  node.innerHTML = `<svg viewBox="0 0 132 56" role="img" aria-label="${esc(label)}"><rect x="2" y="2" width="128" height="52" rx="8"/><rect x="7" y="7" width="118" height="42" rx="5"/><text class="bk-stamp-word" x="66" y="${when ? 31 : 37}" text-anchor="middle">${esc(word('Sent').toLocaleUpperCase())}</text><text class="bk-stamp-when" x="66" y="43" text-anchor="middle">${esc(when)}</text></svg>`;
  node.classList.add('bk-stamped');
  if (fresh) stamp(node);
}
const timeOf = at =>
  new Date(at).toLocaleString(scope ? document.documentElement.lang : undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
