// The page's controls on the bar along the book's foot (bookui.js lays the bar out).
// - In its middle: the page before, where the page is in its chapter ("3 / 12") and the page after. "3 / 12" opens the
//   notebook's pages by name, with the page's title at their head to write in.
// - At its right: the overview and New page. Where the page is narrow they fold into the dots menu.
// - The dots menu: Tear off and send (booktear.js) and Archive this page (into the overview's archived pages,
//   bookshelf.js). Then Preferences for this device (bookprefs.js), Sign in another device (pair.js) and Close.
// The page's name is its title, drawn at its head (bookunits.js), and its control's label. The board's page goes by
// tearing it off at its spine's edge onto Submit (booktear.js). Once sent it's locked: the tools go, Undo and Redo with
// them, and on a sketch page Duplicate takes their place, a copy to carry on drawing from (bookpages.js). An invited
// person's page goes by its Send key on the bar (bookpagesend.js), never on a page already sent or a call's notes page.
import { button, island, setPressed, beside } from './bookui.js';
import { icon } from '../icons.js';
import { mountPrefs } from './bookprefs.js';
import { esc } from '../../util.js';
import { nameOf } from './bookhead.js';
import { shut } from './booksave.js';
import { editTitle } from './booktitle.js';
import { mountForYou } from './bookforyou.js';
import { indexesIn } from './notebookchapters.js';
import { scope, word } from './bookscope.js';

// book (bookpages.js): { views, cur }. act: what the controls do, bookpages.js's: overview(), level(), turnTo(i),
// newPage(), duplicate() (the page shown's copy), archive() (the page shown), send() (an invited person's). Returns
// { update() }: the controls say where the book is now.
export function mountControls(book, act) {
  const over = button({
      icon: icon('grid'),
      label: word('allPages'),
      onClick: () => act.overview(),
      pressed: false,
    }),
    cog = button({ icon: icon('app-settings'), label: word('preferences') });
  over.classList.add('bk-overview-key');
  cog.classList.add('bk-cog');
  mountPrefs(cog);
  const { before, after, name, add } = pageButtons(book, act);
  // (a one-page book, a guest's, has nothing to turn: no arrows, no count, no overview or New page)
  if (!scope?.singlePage) {
    island('pages').append(before, name, after);
    island('keys').append(over, add);
  }
  island('book').prepend(cog);
  const archive = scope ? null : archiveKey(act);
  titleTaps(book, act, name);
  // (the asks still open on the page, counted by its title; in a guest's book, the scraps handed to them.)
  const forYou = mountForYou(book);
  const send = scope ? sendKey(act) : null,
    locked = scope ? null : lockLine(act);
  return {
    update() {
      const far = act.level() !== 'page',
        page = book.views[book.cur]?.page;
      // (the overview open: only its own key, pressed, to come back by: bookstrip.css)
      setPressed(over, far);
      const still = !far && !!page && shut(page);
      if (send) send.hidden = far || !page || shut(page) || page.kind === 'call';
      locked?.(still && page);
      // (a locked page takes no change, but a guest's send can still be taken back; once sent, no Tear off and send:
      // booktear.js)
      historyKeys(book, page, still);
      book.tear?.();
      if (archive) archive.hidden = far || !page;
      before.disabled = mate(book, -1) < 0;
      after.disabled = mate(book, 1) < 0;
      name.disabled = !page;
      // (the title being written goes when its page does, a save still out landing on its page alone)
      if (titling && (far || titling.page !== page)) titling.end(false);
      forYou?.update(far);
      if (!page) return;
      const mates = matesOf(book);
      named(name, page, mates.indexOf(book.cur) + 1, mates.length);
    },
  };
}
// Undo and Redo, hidden on a locked page (still), unless it's a guest's page whose send can still be taken back: in its
// seconds to undo, its step still there (bookpagesend.js).
function historyKeys(book, page, still) {
  const undoable = !!scope && !!page?.sending && book.steps.some(s => s.page === page);
  for (const b of island('history').children) b.hidden = still && !undoable;
}
// The page's title tapped in its head: the pages open with it to write in
function titleTaps(book, act, name) {
  book.paper.addEventListener(
    'click',
    e => e.target.closest('.bk-title-tap') && !name.disabled && menu(book, act, name, true),
  );
}
// Where the page is in its chapter on the bar ("3 / 12"), its name in the label (and the tooltip)
function named(name, page, at, n) {
  name.textContent = `${at} / ${n}`;
  name.setAttribute(
    'aria-label',
    word('notebookPagesAt', { page: nameOf(page) }) + (n > 1 ? word('pageOfPages', { at, n }) : ''),
  );
}

// The pages' buttons: the page before and after, where it is (the notebook's pages), and New page (.bk-rare: in the
// dots menu, bookstrip.css)
function pageButtons(book, act) {
  const name = button({ label: word('notebookPages'), onClick: () => menu(book, act, name) }),
    before = button({ icon: icon('prev'), label: word('pageBefore'), onClick: () => turnOn(book, act, -1) }),
    after = button({ icon: icon('next'), label: word('pageAfter'), onClick: () => turnOn(book, act, 1) }),
    add = button({
      icon: icon('page-new'),
      label: word('newPage'),
      keys: word('newPageHint'),
      onClick: () => act.newPage(),
    });
  name.classList.add('bk-where');
  name.setAttribute('aria-haspopup', 'menu');
  add.classList.add('bk-rare');
  return { before, after, name, add };
}
// The page before or after in the shown page's chapter (its index in book.views, -1 at the chapter's end): the arrows
// stay within the tab, never turning on into the next one
function mate(book, step) {
  const mates = matesOf(book);
  return mates[mates.indexOf(book.cur) + step] ?? -1;
}
function turnOn(book, act, step) {
  const i = mate(book, step);
  if (i >= 0) act.turnTo(i);
}
// An invited person's Send, on the bar before its dots
function sendKey(act) {
  const send = button({
    icon: icon('send'),
    label: word('send'),
    keys: word('sendHint'),
    onClick: () => act.send(),
  });
  send.classList.add('bk-send');
  island('send').append(send);
  return send;
}
// Archive this page, in the dots menu
function archiveKey(act) {
  const archive = button({ icon: icon('box'), label: word('archivePage'), onClick: () => act.archive() });
  island('menu').append(archive);
  return archive;
}
// The board's page sent, or else read-only (a call's notes page till its follow-up hands it out): locked, the tools
// unseen in their room (bookshare.css). Read-only, a lock in their place and "Locked"; sent, nothing, the SENT stamp on
// the page says it. A sketch page's tools give way to Duplicate, lit as the one
// to press: the board carries on from a page it sent on its copy. The tools'
// island goes where neither shows. Returns locked(the page shown when locked, or false).
function lockLine(act) {
  const line = island('tools').closest('.bk-strip'),
    lock = document.createElement('p'),
    copy = button({
      icon: icon('duplicate'),
      text: word('duplicate'),
      label: word('duplicatePage'),
      keys: word('duplicatePageHint'),
      onClick: () => act.duplicate(),
    });
  lock.className = 'bk-locked';
  lock.innerHTML = `${icon('lock')}<span>Locked</span>`;
  lock.setAttribute('role', 'status');
  copy.classList.add('bk-duplicate');
  line.append(lock, copy);
  return page => {
    line.toggleAttribute('data-locked', !!page);
    lock.hidden = !page || !!(page.sent || page.sending);
    copy.hidden = !page || page.chapter !== 'sketch';
    line.hidden = !!page && lock.hidden && copy.hidden;
  };
}

// The pages of the shown page's tab by name, in order, the one shown marked; a choice turns to it once the title is
// through. The shown page's title is written at their head meanwhile (booktitle.js): the pages close as it ends, saved,
// let go or its page gone, and stay open on a refused save, the refusal under the field. Their control tapped again saves the title as a tap away does; write: opened from the page's
// title, to write it in.
let open = null,
  titling = null;
function menu(book, act, from, write = false) {
  if (open) return write ? writeIn() : titling.end(true);
  const card = document.createElement('div');
  card.className = 'bk-card bk-pages-menu';
  card.setAttribute('role', 'menu');
  card.setAttribute('aria-label', word('pages'));
  card.innerHTML = menuOf(book);
  titling = editTitle(from, book, card, () => {
    titling = null;
    close();
  });
  beside(card, from);
  card.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    titling.end(true).then(saved => saved && act.turnTo(Number(b.dataset.i)));
  });
  // (a tap away and Escape are the title's, booktitle.js: saving it or letting it go closes the pages. A tap on their
  // control is its click's.)
  from.setAttribute('aria-expanded', 'true');
  open = { card, from };
  // (a touch screen raises its keyboard over the pages for a focused field: there the shown page's row has the focus,
  // and a tap on the title writes, unless it's the title that was tapped)
  if (write || matchMedia('(pointer: fine)').matches) writeIn();
  else card.querySelector('[aria-current]')?.focus({ preventScroll: true });
}
// The title's field focused to write in, what's there chosen
function writeIn() {
  titling.field.focus({ preventScroll: true });
  titling.field.select();
}
// The pages closed, the title left as it is
function close() {
  if (!open) return;
  open.card.remove();
  open.from.setAttribute('aria-expanded', 'false');
  open = null;
}

// The menu's rows: the shown page's chapter, numbered as the counter shows them ("2/8": 2), each turning to its index
// in book.views
function menuOf(book) {
  return `<ul class="bk-menu">${matesOf(book)
    .map(
      (i, at) =>
        `<li><button role="menuitem" data-i="${i}"${i === book.cur ? ' aria-current="page"' : ''}><small>${at + 1}</small>${esc(
          nameOf(book.views[i].page),
        )}</button></li>`,
    )
    .join('')}</ul>`;
}
// The shown page's chapter, its bookmark's pages (their indexes in book.views): what the arrows turn within, the
// counter counts ("2/8") and the page list lists, numbered alike
const matesOf = book =>
  indexesIn(
    book.views.map(v => v.page),
    book.views[book.cur]?.page.chapter,
  );
