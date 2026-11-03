// The page's controls on the bar along the book's foot (bookui.js): in its middle the page before, where it is in its
// chapter ("3 / 12", which opens the notebook's pages by name, the page's title at their head to write in) and the
// page after; at its right the overview and New page where the page is wide enough (else in its dots menu), and in the
// dots menu Tear off and send (booktear.js) and the cog for this device's preferences (bookprefs.js). The page's name is
// its title, drawn at its head (bookunits.js), and its control's label. The board's page goes by tearing it off at its
// spine's edge onto Submit (booktear.js), and once sent it's locked: the tools give way to a quiet "Sent, locked". An
// invited person's page goes by its Send key on the bar (bookpagesend.js); none on a page sent, nor on a call's notes
// page.
import { button, island, setPressed, lineIcon, beside } from './bookui.js';
import { mountPrefs } from './bookprefs.js';
import { esc } from '../../util.js';
import { nameOf } from './bookhead.js';
import { shut } from './booksave.js';
import { editTitle } from './booktitle.js';
import { mountForYou } from './bookforyou.js';
import { indexesIn } from './notebookchapters.js';

const ICONS = {
  // (the notebook's pages laid out: four leaves in a grid, as far apart top to bottom as side to side.)
  overview: lineIcon(
    '<rect x="4" y="3" width="6.5" height="7.5" rx="1.2"/><rect x="13.5" y="3" width="6.5" height="7.5" rx="1.2"/><rect x="4" y="13.5" width="6.5" height="7.5" rx="1.2"/><rect x="13.5" y="13.5" width="6.5" height="7.5" rx="1.2"/>',
  ),
  before: lineIcon('<path d="M14.5 6l-6 6 6 6"/>'),
  after: lineIcon('<path d="M9.5 6l6 6-6 6"/>'),
  page: lineIcon('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M12 11v6M9 14h6"/>'),
  // (a paper plane)
  send: lineIcon('<path d="M21 3L3 10.5l7 2.5 2.5 7z"/><path d="M21 3l-11 10"/>'),
  // (a padlock, shut)
  lock: lineIcon('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  cog: lineIcon(
    '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/><circle cx="12" cy="12" r="6.4"/>',
  ),
};
import { scope, word } from './bookscope.js';

// book (bookpages.js): { views, cur }. act: what the controls do, bookpages.js's: overview(), level(), turnTo(i),
// newPage(), send() (an invited person's). Returns { update() }: the controls say where the book is now.
export function mountControls(book, act) {
  const over = button({
      icon: ICONS.overview,
      label: word('allPages'),
      onClick: () => act.overview(),
      pressed: false,
    }),
    cog = button({ icon: ICONS.cog, label: word('preferences') });
  over.classList.add('bk-rare', 'bk-overview-key');
  cog.classList.add('bk-cog');
  mountPrefs(cog);
  const { before, after, name, add } = pageButtons(book, act);
  // (a one-page book, a guest's, has nothing to turn: no arrows, no count, no overview or New page)
  if (!scope?.singlePage) {
    island('pages').append(before, name, after);
    island('keys').append(over, add);
  }
  island('book').prepend(cog);
  titleTaps(book, act, name);
  // (the asks still open on the page, counted by its title; in a guest's book, the scraps handed to them.)
  const forYou = mountForYou(book);
  const send = scope ? sendKey(act) : null,
    locked = scope ? null : lockLine();
  return {
    update() {
      const far = act.level() !== 'page',
        page = book.views[book.cur]?.page;
      // (the overview open: only its own key, pressed, to come back by: bookstrip.css)
      setPressed(over, far);
      if (send) send.hidden = far || !page || shut(page) || page.kind === 'call';
      locked?.(!far && !!page && shut(page) && (page.sent || page.sending ? 'Sent, locked' : 'Locked'));
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
// dots menu where the page is narrow, bookstrip.css)
function pageButtons(book, act) {
  const name = button({ label: word('notebookPages'), onClick: () => menu(book, act, name) }),
    before = button({ icon: ICONS.before, label: word('pageBefore'), onClick: () => turnOn(book, act, -1) }),
    after = button({ icon: ICONS.after, label: word('pageAfter'), onClick: () => turnOn(book, act, 1) }),
    add = button({
      icon: ICONS.page,
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
// stay within the tab, never turning on into the next one (board, call 178.)
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
    icon: ICONS.send,
    label: word('send'),
    keys: word('sendHint'),
    onClick: () => act.send(),
  });
  send.classList.add('bk-send');
  island('send').append(send);
  return send;
}
// The board's page sent, or else read-only (a call's notes page till its follow-up hands it out): locked, a lock in
// the tools' place, its words its tooltip, the tools unseen in their room while it shows (bookshare.css). Returns
// locked(words, or false).
function lockLine() {
  const line = island('tools').closest('.bk-strip'),
    lock = document.createElement('p');
  lock.className = 'bk-locked';
  lock.innerHTML = `${ICONS.lock}<span></span>`;
  lock.setAttribute('role', 'status');
  line.append(lock);
  return words => {
    line.toggleAttribute('data-locked', !!words);
    if (words) lock.lastChild.textContent = words;
  };
}

// The pages of the shown page's tab by name, in order, the one shown marked; a choice turns to it once the title is
// through. The shown page's title is written in place of its name meanwhile (booktitle.js): the pages close as it ends
// or its save is refused, and it lasts until it's saved or let go, or its page goes. Their control tapped again closes
// them as a tap away does, the title saved (board, call 178); write: opened from the page's title, to write it in.
let open = null,
  titling = null;
function menu(book, act, from, write = false) {
  if (open) return write ? writeIn() : titling ? titling.end(true) : close();
  const card = document.createElement('div');
  card.className = 'bk-card bk-pages-menu';
  card.setAttribute('role', 'menu');
  card.setAttribute('aria-label', word('pages'));
  card.innerHTML = menuOf(book);
  titling = editTitle(from, book, card, ended => {
    if (ended) titling = null;
    close();
  });
  beside(card, from);
  card.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    close();
    titling.end(true).then(saved => saved && act.turnTo(Number(b.dataset.i)));
  });
  // (a tap away closes the pages and saves the title, booktitle.js; Escape is the title's: letting it go closes them. A
  // tap on their control is its click's.)
  const away = e => ![card, titling.box, from].some(el => el.contains(e.target)) && close();
  addEventListener('pointerdown', away, true);
  from.setAttribute('aria-expanded', 'true');
  open = { card, from, shut: () => removeEventListener('pointerdown', away, true) };
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
  open.shut();
  open.card.remove();
  open.from.setAttribute('aria-expanded', 'false');
  open = null;
}

// The menu's rows: the shown page's chapter, numbered as the counter shows them ("2/8": 2), each turning to its index
// in book.views (board, call 178.)
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
