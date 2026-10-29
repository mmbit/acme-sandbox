// The controls for moving about the book, in the row at the paper's foot (bookui.js): the overview at its left end, the
// page before and after, the page's name and where it is in the notebook, which opens the notebook's pages by name, New
// page, and Send at the row's right end, the page's own action (the page shown sent whole, bookpagesend.js; none on a
// page sent). While the zoom is off 100% its % shows beside the page after, a tap back to 100%, apart from Send. Ctrl/⌘
// with +, − and 0 zoom too, while the book has the pointer or the focus (never HQ's page's own zoom). (the overview and
// the zoom's % in the row: job #19861; a notebook's pages and Send, Your book and the days gone; Send apart from the
// zoom: the board, 28 Oct)
import { button, island, setPressed, MOD, lineIcon } from './bookui.js';
import { esc } from '../../util.js';
import { nameOf } from './bookhead.js';
import { shut } from './booksave.js';
import { mountTitle } from './booktitle.js';

const ICONS = {
  // (the notebook's pages laid out: four leaves in a grid, as far apart top to bottom as side to side: the board's call
  // 149)
  overview: lineIcon(
    '<rect x="4" y="3" width="6.5" height="7.5" rx="1.2"/><rect x="13.5" y="3" width="6.5" height="7.5" rx="1.2"/><rect x="4" y="13.5" width="6.5" height="7.5" rx="1.2"/><rect x="13.5" y="13.5" width="6.5" height="7.5" rx="1.2"/>',
  ),
  before: lineIcon('<path d="M14.5 6l-6 6 6 6"/>'),
  after: lineIcon('<path d="M9.5 6l6 6-6 6"/>'),
  page: lineIcon('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M12 11v6M9 14h6"/>'),
  // (a paper plane)
  send: lineIcon('<path d="M21 3L3 10.5l7 2.5 2.5 7z"/><path d="M21 3l-11 10"/>'),
};
import { word } from './bookscope.js';

// book (bookpages.js): { views, cur, scale }. act: what the controls do, bookpages.js's: zoom(k), actual(), overview(),
// level(), turnTo(i), newPage(), send(). Returns { update() }: the controls say where the book is now.
export function mountControls(book, act) {
  const pages = island('pages'),
    over = button({
      icon: ICONS.overview,
      label: book.scope ? word("The notebook's pages") : "The overview: the notebook's pages, and the Shelf",
      onClick: () => act.overview(),
      pressed: false,
    }),
    pct = button({ text: '100%', label: word('Back to 100%'), keys: `${MOD}0`, onClick: () => act.actual() });
  pct.classList.add('bk-quiet', 'bk-pct');
  const { before, after, name, add, send } = pageButtons(book, act),
    rule = document.createElement('hr');
  send.classList.add('bk-send');
  // (the zoom's % with the page it's of; New page, then Send at the row's end, the page's own action)
  pages.append(over, before, name, after, pct, rule, add, send);
  keys(book, act);

  return {
    update() {
      const far = act.level() !== 'page',
        page = book.views[book.cur]?.page,
        n = book.views.length,
        percent = Math.round(book.scale * 100);
      setPressed(over, far);
      // (the overview open: only its own button, pressed, to come back by)
      for (const el of [before, name, after, rule]) el.hidden = far;
      over.hidden = !!book.scope?.singlePage;
      add.hidden = far || !!book.scope?.singlePage;
      send.hidden = far || !page || shut(page) || page.readonly;
      pct.hidden = far || percent === 100;
      pct.querySelector('span').textContent = `${percent}%`;
      before.disabled = book.cur <= 0;
      after.disabled = book.cur >= n - 1;
      name.disabled = !page;
      if (!page) return;
      // (where it is in the notebook only when it has more than one page)
      const many = n > 1;
      name.innerHTML = `<span>${esc(nameOf(page))}</span>${many ? `<small>${book.cur + 1} / ${n}</small>` : ''}`;
      name.setAttribute(
        'aria-label',
        word("The notebook's pages: {page}", { page: nameOf(page) }) +
          (many ? word(', {at} of {n}', { at: book.cur + 1, n }) : ''),
      );
    },
  };
}

// The pages' buttons: the page before and after, the page's name (the notebook's pages), New page and Send
function pageButtons(book, act) {
  const name = button({
    text: word('Page'),
    label: word("The notebook's pages"),
    onClick: () => menu(book, act, name),
  });
  name.classList.add('bk-quiet', 'bk-where');
  name.setAttribute('aria-haspopup', 'dialog');
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
    send: button({
      icon: ICONS.send,
      text: word('Send'),
      label: word('Send'),
      keys: word('This page to the agents: 10 seconds to undo'),
      onClick: () => act.send(),
    }),
  };
}

// The shown page's title field and the notebook's pages by name, in order. A choice turns to that page.
let open = null;
function menu(book, act, from) {
  if (open) return close();
  const card = document.createElement('div');
  card.className = 'bk-card bk-pages-menu';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', word('Page title and pages'));
  card.innerHTML = menuOf(book);
  const field = mountTitle(card, book, () => {
    book.controls.update();
    close();
    from.focus();
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
    if (!b?.hasAttribute('data-i')) return;
    close();
    act.turnTo(Number(b.dataset.i));
  });
  const away = e => !card.contains(e.target) && !from.contains(e.target) && close();
  const esc_ = e => e.key === 'Escape' && (close(), from.focus());
  addEventListener('pointerdown', away, true);
  addEventListener('keydown', esc_);
  from.setAttribute('aria-expanded', 'true');
  open = { card, shut: () => (removeEventListener('pointerdown', away, true), removeEventListener('keydown', esc_)) };
  // (a touch screen raises its keyboard over the pages for a focused field: there the shown page's row has the focus,
  // and a tap on the field types)
  if (matchMedia('(pointer: fine)').matches) {
    field.focus({ preventScroll: true });
    field.select();
  } else card.querySelector('[aria-current]')?.focus({ preventScroll: true });
  function close() {
    open?.shut();
    open?.card.remove();
    open = null;
    from.setAttribute('aria-expanded', 'false');
  }
}

// The menu's rows: the notebook's pages
function menuOf(book) {
  return `<ul class="bk-menu" role="menu" aria-label="${word('Pages')}">${book.views
    .map(
      (v, i) =>
        `<li><button role="menuitem" data-i="${i}"${i === book.cur ? ' aria-current="page"' : ''}><small>${i + 1}</small>${esc(
          nameOf(v.page),
        )}</button></li>`,
    )
    .join('')}</ul>`;
}

// Ctrl/⌘ with + (or =), − and 0: the book's zoom, when it has the pointer or the focus and nothing's being typed
function keys(book, act) {
  addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const leaf = book.desk.closest('.bk-leaf') ?? book.desk,
      typing = e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]');
    if (typing || !(leaf.matches(':hover') || leaf.contains(document.activeElement))) return;
    const k = { '+': 1.25, '=': 1.25, '-': 0.8, _: 0.8, 0: 0 }[e.key];
    if (k === undefined) return;
    e.preventDefault();
    if (k) act.zoom(k);
    else act.actual();
  });
}
