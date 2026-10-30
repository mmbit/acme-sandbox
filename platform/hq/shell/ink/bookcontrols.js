// The page bar at the paper's foot, under the tool rail (bookui.js's lane): the page before and after, the page's name
// and where it is in the notebook ("Shop launch · 2 / 3", which opens the notebook's pages by name), then the overview,
// New page and the cog for this device's preferences (bookprefs.js). It sits right at the screen's bottom, its buttons
// clear of a phone's rounded corners, and its name is cut short only where it can't fit (bookdesk.css). The board's page
// goes by its dog-ear onto Submit (bookdogear.js), and once sent it's locked: the rail gives way to a quiet "Sent,
// locked". An invited person's page goes by its Send key (bookpagesend.js), an
// island beside the rail; none on a page sent, nor on a call's notes page.
import { button, island, setPressed, lineIcon } from './bookui.js';
import { mountPrefs } from './bookprefs.js';
import { esc } from '../../util.js';
import { nameOf } from './bookhead.js';
import { shut } from './booksave.js';
import { editTitle } from './booktitle.js';
import { mountForYou } from './bookforyou.js';

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
import { word } from './bookscope.js';

// book (bookpages.js): { views, cur }. act: what the controls do, bookpages.js's: overview(), level(), turnTo(i),
// newPage(), send() (an invited person's). Returns { update() }: the controls say where the book is now.
export function mountControls(book, act) {
  const pages = island('pages'),
    over = button({
      icon: ICONS.overview,
      label: book.scope ? word("The notebook's pages") : "The overview: the notebook's pages, and the Shelf",
      onClick: () => act.overview(),
      pressed: false,
    }),
    cog = button({ icon: ICONS.cog, label: word('Preferences on this device') });
  cog.classList.add('bk-cog');
  mountPrefs(cog);
  const { before, after, name, add } = pageButtons(book, act),
    rule = document.createElement('hr');
  pages.append(before, after, name, rule, over, add, cog);
  const send = book.scope ? sendKey(act) : null,
    locked = book.scope ? null : lockLine();
  // (the asks still open on the page, counted over its name: the board's own book only.)
  const forYou = book.scope ? null : mountForYou(book, pages);
  return {
    update() {
      const far = act.level() !== 'page',
        page = book.views[book.cur]?.page,
        n = book.views.length;
      setPressed(over, far);
      // (the overview open: only its own button, pressed, to come back by)
      for (const el of [before, name, after, rule]) el.hidden = far;
      over.hidden = !!book.scope?.singlePage;
      add.hidden = far || !!book.scope?.singlePage;
      cog.hidden = far;
      if (send) send.hidden = far || !page || shut(page) || page.kind === 'call';
      locked?.(!far && !!page && shut(page) && (page.sent || page.sending ? 'Sent, locked' : 'Locked'));
      before.disabled = book.cur <= 0;
      after.disabled = book.cur >= n - 1;
      name.disabled = !page;
      // (the title being written goes when its page does, a save still out landing on its page alone)
      if (titling && (far || titling.page !== page)) titling.end(false);
      forYou?.update(far);
      if (!page) return;
      // (where it is in its chapter, its bookmark's pages)
      const mates = book.views.filter(v => v.page.chapter === page.chapter);
      named(name, page, mates.findIndex(v => v.page === page) + 1, mates.length);
    },
  };
}
// The page's name in the row, and where it is in its chapter (at of n) only when that has more than one page
function named(name, page, at, n) {
  const many = n > 1;
  name.innerHTML = `<span>${esc(nameOf(page))}</span>${many ? `<small>· ${at} / ${n}</small>` : ''}`;
  name.setAttribute(
    'aria-label',
    word("The notebook's pages: {page}", { page: nameOf(page) }) + (many ? word(', {at} of {n}', { at, n }) : ''),
  );
}

// The pages' buttons: the page before and after, the page's name (the notebook's pages), and New page
function pageButtons(book, act) {
  const name = button({
    text: word('Page'),
    label: word("The notebook's pages"),
    onClick: () => menu(book, act, name),
  });
  name.classList.add('bk-quiet', 'bk-where');
  name.setAttribute('aria-haspopup', 'menu');
  return {
    before: button({ icon: ICONS.before, label: word('The page before'), onClick: () => act.turnTo(book.cur - 1) }),
    after: button({ icon: ICONS.after, label: word('The page after'), onClick: () => act.turnTo(book.cur + 1) }),
    name,
    add: button({
      icon: ICONS.page,
      label: word('New page'),
      keys: word('A blank page after the last, for the next part'),
      onClick: () => act.newPage(),
    }),
  };
}
// An invited person's Send, its own island beside the rail
function sendKey(act) {
  const send = button({
    icon: ICONS.send,
    label: word('Send'),
    keys: word('This page to the agents: 10 seconds to undo'),
    onClick: () => act.send(),
  });
  send.classList.add('bk-send');
  island('send').append(send);
  return send;
}
// The board's page sent, or else read-only (a call's notes page till its follow-up hands it out): locked, its words in
// the rail's place, the tools gone while they show (bookshare.css). Returns locked(words, or false).
function lockLine() {
  const line = island('tools').closest('.bk-lane-line'),
    lock = document.createElement('p');
  lock.className = 'bk-locked';
  lock.innerHTML = `${ICONS.lock}<span></span>`;
  line.append(lock);
  return words => {
    line.toggleAttribute('data-locked', !!words);
    if (words) lock.lastChild.textContent = words;
  };
}

// The notebook's pages by name, in order, the one shown marked; a choice turns to it once the title is through. The
// shown page's title is written in place of its name meanwhile (booktitle.js): the pages close as it ends or its save
// is refused, and it lasts until it's saved or let go, or its page goes.
let open = null,
  titling = null;
function menu(book, act, from) {
  if (open) return close();
  const card = document.createElement('div');
  card.className = 'bk-card bk-pages-menu';
  card.setAttribute('role', 'menu');
  card.setAttribute('aria-label', word('Pages'));
  card.innerHTML = menuOf(book);
  titling = editTitle(from, book, card, ended => {
    if (ended) titling = null;
    close();
  });
  (from.closest('#book') ?? document.body).append(card);
  const r = from.closest('.bk-island').getBoundingClientRect(),
    c = card.getBoundingClientRect();
  Object.assign(card.style, {
    left: `${Math.round(Math.max(8, Math.min(innerWidth - c.width - 8, r.left + r.width / 2 - c.width / 2)))}px`,
    top: `${Math.round(Math.max(8, r.top - c.height - 8))}px`,
  });
  card.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    close();
    titling.end(true).then(saved => saved && act.turnTo(Number(b.dataset.i)));
  });
  // (a tap away closes the pages and saves the title, booktitle.js; Escape is the title's: letting it go closes them)
  const away = e => ![card, titling.box].some(el => el.contains(e.target)) && close();
  addEventListener('pointerdown', away, true);
  from.setAttribute('aria-expanded', 'true');
  open = { card, from, shut: () => removeEventListener('pointerdown', away, true) };
  // (a touch screen raises its keyboard over the pages for a focused field: there the shown page's row has the focus,
  // and a tap on the title writes)
  if (matchMedia('(pointer: fine)').matches) {
    titling.field.focus({ preventScroll: true });
    titling.field.select();
  } else card.querySelector('[aria-current]')?.focus({ preventScroll: true });
}
// The pages closed, the title left as it is
function close() {
  if (!open) return;
  open.shut();
  open.card.remove();
  open.from.setAttribute('aria-expanded', 'false');
  open = null;
}

// The menu's rows: the notebook's pages
function menuOf(book) {
  return `<ul class="bk-menu">${book.views
    .map(
      (v, i) =>
        `<li><button role="menuitem" data-i="${i}"${i === book.cur ? ' aria-current="page"' : ''}><small>${i + 1}</small>${esc(
          nameOf(v.page),
        )}</button></li>`,
    )
    .join('')}</ul>`;
}
