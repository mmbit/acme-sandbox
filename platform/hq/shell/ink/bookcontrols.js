// The page's controls on the bar along the book's foot (bookui.js lays the bar out).
// - In its middle: the page before, where the page is in its chapter ("3 / 12") and the page after. "3 / 12" opens the
//   notebook's pages by name.
// - At its left the overview (on a page only: the overview shows all the pages already, a page opens by its tile), at
//   its right the dots. New page folds into the dots menu. A guest's Undo of its send is a pill of its own left of
//   the bar (bookui.js).
// - The dots menu: Rename page (its title written where it shows, booktitle.js), Tear off and send (booktear.js),
//   Archive this page (into the overview's archived pages, bookshelf.js) and Give a copy… (to a guest, bookgive.js).
//   Then Preferences for this device (bookprefs.js).
// The page's name is its title, fixed on the view (bookviewhead.js), and its control's label. The board's page goes by
// tearing it off at its spine's edge onto Submit (booktear.js). Once sent it's locked: its scraps' tools go, and on a
// sketch page Duplicate takes their place, a copy to carry on drawing from (bookpages.js). An invited
// person's page goes by its Send key on the bar (bookpagesend.js), never on a page already sent or a call's notes page.
import { button, island, beside, moreKey } from './bookui.js';
import { icon } from '../icons.js';
import { mountPrefs } from './bookprefs.js';
import { esc } from '../../util.js';
import { nameOf } from './bookhead.js';
import { shut } from './booksave.js';
import { editTitle } from './booktitle.js';
import { mountForYou } from './bookforyou.js';
import { giveKey } from './bookgive.js';
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
  const archive = scope ? null : archiveKey(act),
    give = scope ? null : giveKey(book),
    rename = renameKey(book);
  // (the asks still open on the page, counted by its title; in a guest's book, the scraps handed to them.)
  const forYou = mountForYou(book);
  const send = scope ? sendKey(act) : null,
    locked = scope ? null : lockLine(book, act);
  return {
    update() {
      const far = act.level() !== 'page',
        page = book.views[book.cur]?.page;
      const still = !far && !!page && shut(page);
      if (send) send.hidden = far || !page || shut(page) || page.kind === 'call';
      locked?.(still && page);
      // (a locked page takes no change, but a guest's send can still be taken back; once sent, no Tear off and send:
      // booktear.js)
      historyKeys(book, page);
      book.tear?.();
      if (archive) archive.hidden = far || !page;
      give?.(far, page);
      rename(far, page);
      book.head.update(); // (the view's title, after a turn or a rename.)
      before.disabled = mate(book, -1) < 0;
      after.disabled = mate(book, 1) < 0;
      name.disabled = !page;
      forYou?.update(far);
      if (!page) return;
      const mates = matesOf(book);
      named(name, page, mates.indexOf(book.cur) + 1, mates.length);
    },
  };
}
// The bar's Undo, only on a guest's page whose send can still be taken back: in its seconds to undo, its step still
// there (bookpagesend.js). The page itself takes no ink, so drawing's Undo and Redo are an opened scrap's
// (bookscrapopen.js), the keys' on the page too.
function historyKeys(book, page) {
  const undoable = !!scope && !!page?.sending && book.steps.some(s => s.page === page);
  for (const b of island('history').children) b.hidden = !undoable;
}
// Rename page, first of the page's rows in the dots menu (bookui.js): the title written where it shows, on the view
// (bookviewhead.js), the focus going back to the dots as it ends. Returns update(far, page): the overview open or the
// page shown, a sent page keeping the title it went with, and the title being written going when its page does, a save
// still out landing on its page alone.
function renameKey(book) {
  // (its title's words: the text tool's T, the Ink README, The book's icons.)
  const key = button({ icon: icon('tool-text'), label: word('renamePage'), onClick: () => renamed(book) });
  key.classList.add('bk-rename');
  island('menu').prepend(key);
  return (far, page) => {
    key.hidden = far || !page || !!(page.sent || page.sending);
    if (titling && (far || titling.page !== page)) titling.end(false);
  };
}
function renamed(book) {
  titling ??= editTitle(moreKey(), book, book.head.el, () => (titling = null));
  titling.field.focus({ preventScroll: true });
  titling.field.select();
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
    before = arrowKey(word('pageBefore'), icon('prev'), () => turnOn(book, act, -1)),
    after = arrowKey(word('pageAfter'), icon('next'), () => turnOn(book, act, 1)),
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
// An arrow: a finger's or a pen's tap turns as it lifts on the arrow, not waiting on the click Safari makes of it (on
// the iPad it makes none for a tap it takes as part of a gesture, quick taps above all). A click within TAP_CLICK_MS of
// a tap's turn is that tap's: Safari's, or the iPad app's replayed Pencil tap, whose click() has no detail
// (booknative.js); a mouse's or a key's is its own. A tap during a turn turns on from the page it's turning to (book.cur
// is that page at once: bookpages.js).
// (A second: Safari's click can come late behind a turn's frames, and a long window costs nothing, since every tap
// acts on its own lift and only a mouse's click within a second of a finger's tap would go. The tools' slide drops its
// lift's click within 60 ms instead, bookstrip.js noClick(): there a tap acts by its click, so only the click that
// comes with the lift itself may go.)
const TAP_CLICK_MS = 1000;
function arrowKey(label, svg, go) {
  return onEveryTap(button({ icon: svg, label }), go);
}
// A key that answers every tap: a finger's or the Pencil's on its lift on the key (iPad Safari makes no click of some),
// a mouse's or the keyboard's on its click, never both.: shared
export function onEveryTap(b, go) {
  let pressing = null,
    turnedAt = -Infinity;
  b.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' && e.isPrimary) pressing = e.pointerId;
  });
  b.addEventListener('pointercancel', () => (pressing = null));
  b.addEventListener('pointerup', e => {
    if (e.pointerId !== pressing) return;
    pressing = null;
    const r = b.getBoundingClientRect(),
      onKey = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!onKey || b.disabled) return;
    turnedAt = e.timeStamp;
    go();
  });
  b.addEventListener('click', e => {
    if (e.timeStamp - turnedAt < TAP_CLICK_MS) return;
    go();
  });
  return b;
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
// unseen in their room (bookshare.css). Read-only, the view's head says "Locked" under the title, fixed as it is while
// the page scrolls (bookviewhead.js); sent, nothing, the SENT stamp on the page
// says it. A sketch page's tools give way to Duplicate, lit as the one to press: the board carries on from a page it
// sent on its copy. The tools' island goes where it doesn't show. Returns locked(the page shown when locked, or false).
function lockLine(book, act) {
  const line = island('tools').closest('.bk-strip'),
    copy = button({
      icon: icon('duplicate'),
      text: word('duplicate'),
      label: word('duplicatePage'),
      keys: word('duplicatePageHint'),
      onClick: () => act.duplicate(),
    });
  copy.classList.add('bk-duplicate');
  line.append(copy);
  return page => {
    line.toggleAttribute('data-locked', !!page);
    book.head.locked(!!page && !(page.sent || page.sending));
    copy.hidden = !page || page.chapter !== 'sketch';
    line.hidden = !!page && copy.hidden;
  };
}

// The pages of the shown page's tab by name, in order, the one shown marked; a choice turns to it. A tap away, Escape
// or their control tapped again closes them.
let open = null,
  titling = null;
function menu(book, act, from) {
  if (open) return close();
  const card = document.createElement('div');
  card.className = 'bk-card bk-pages-menu';
  card.setAttribute('role', 'menu');
  card.setAttribute('aria-label', word('pages'));
  card.innerHTML = menuOf(book);
  beside(card, from);
  card.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    close();
    act.turnTo(Number(b.dataset.i));
  });
  // (a tap on their control is its click's)
  const away = e => {
    if (e.type === 'keydown' ? e.key === 'Escape' : !(card.contains(e.target) || from.contains(e.target))) close();
  };
  addEventListener('pointerdown', away, true);
  addEventListener('keydown', away, true);
  from.setAttribute('aria-expanded', 'true');
  open = { card, from, away };
  card.querySelector('[aria-current]')?.focus({ preventScroll: true });
}
// The pages closed
function close() {
  if (!open) return;
  removeEventListener('pointerdown', open.away, true);
  removeEventListener('keydown', open.away, true);
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
