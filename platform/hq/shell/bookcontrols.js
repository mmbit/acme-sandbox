// The controls for moving about the book, in the row at the paper's foot (bookui.js): the overview at its left end, the
// page before and after, the page's name and where it is in the day, which opens the day's pages by name and the days
// either side, and New page; in an invited person's book, Your book in its place, back to the board's own. While the
// zoom is off 100% its % shows at the row's right end, a tap back to 100%. Ctrl/⌘ with +, − and 0 zoom too, while the
// book has the pointer or the focus (never HQ's page's own zoom). (Your book: job
// #19223; the overview and the zoom's % in the row: job #19861)
import { button, island, setPressed, MOD, lineIcon as svg } from './bookui.js';
import { esc } from '../util.js';
import { dayName, nameOf } from './bookhead.js';

const ICONS = {
  // (the day's pages laid out: four leaves in a grid)
  overview: svg(
    '<rect x="4" y="3.5" width="6.5" height="7.5" rx="1.2"/><rect x="13.5" y="3.5" width="6.5" height="7.5" rx="1.2"/><rect x="4" y="13" width="6.5" height="7.5" rx="1.2"/><rect x="13.5" y="13" width="6.5" height="7.5" rx="1.2"/>',
  ),
  before: svg('<path d="M14.5 6l-6 6 6 6"/>'),
  after: svg('<path d="M9.5 6l6 6-6 6"/>'),
  page: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M12 11v6M9 14h6"/>'),
};

// book (bookpages.js): { views, cur, day, today, days, scale, whose }. act: what the controls do, bookpages.js's:
// zoom(k), actual(), overview(), level(), turnTo(i), newPage(), openDay(day), mine(). Returns { update() }: the controls
// say where the book is now.
export function mountControls(book, act) {
  const pages = island('pages'),
    over = button({
      icon: ICONS.overview,
      label: "The overview: the day's pages, and the week",
      onClick: () => act.overview(),
      pressed: false,
    }),
    pct = button({ text: '100%', label: 'Back to 100%', keys: `${MOD}0`, onClick: () => act.actual() });
  pct.classList.add('bk-quiet', 'bk-pct');
  const { before, after, name, add, mine } = pageButtons(book, act),
    rule = document.createElement('hr');
  pages.append(over, before, name, after, rule, add, mine, pct);
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
      add.hidden = far || !!book.whose;
      mine.hidden = far || !book.whose;
      pct.hidden = far || percent === 100;
      pct.querySelector('span').textContent = `${percent}%`;
      before.disabled = book.cur <= 0;
      after.disabled = book.cur >= n - 1;
      name.disabled = !page;
      if (!page) return;
      // (where it is in the day only when the day has more than one page)
      const many = n > 1;
      name.innerHTML = `<span>${esc(nameOf(page))}</span>${many ? `<small>${book.cur + 1} / ${n}</small>` : ''}`;
      name.setAttribute('aria-label', `The day's pages: ${nameOf(page)}${many ? `, ${book.cur + 1} of ${n}` : ''}`);
    },
  };
}

// The pages' buttons: the page before and after, the page's name (the day's pages), New page, and Your book (hidden
// till an invited person's book is open)
function pageButtons(book, act) {
  const name = button({ text: 'Today', label: "The day's pages", onClick: () => menu(book, act, name) }),
    mine = button({ text: 'Your book', label: 'Back to your own book', onClick: () => act.mine() });
  name.classList.add('bk-quiet', 'bk-where');
  name.setAttribute('aria-haspopup', 'menu');
  mine.hidden = true;
  return {
    before: button({ icon: ICONS.before, label: 'The page before', onClick: () => act.turnTo(book.cur - 1) }),
    after: button({ icon: ICONS.after, label: 'The page after', onClick: () => act.turnTo(book.cur + 1) }),
    name,
    add: button({
      icon: ICONS.page,
      label: 'New page',
      keys: 'A blank page after the last, for the next part',
      onClick: () => act.newPage(),
    }),
    mine,
  };
}

// The day's pages by name, in order, the one shown marked, and the days either side; a choice opens it
let open = null;
function menu(book, act, from) {
  if (open) return shut();
  const card = document.createElement('div');
  card.className = 'bk-card bk-pages-menu';
  card.setAttribute('role', 'menu');
  card.innerHTML = menuOf(book);
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
    shut();
    if (b.dataset.i) act.turnTo(Number(b.dataset.i));
    else act.openDay(b.dataset.day);
  });
  const away = e => !card.contains(e.target) && !from.contains(e.target) && shut();
  const esc_ = e => e.key === 'Escape' && (shut(), from.focus());
  addEventListener('pointerdown', away, true);
  addEventListener('keydown', esc_);
  from.setAttribute('aria-expanded', 'true');
  open = { card, shut: () => (removeEventListener('pointerdown', away, true), removeEventListener('keydown', esc_)) };
  card.querySelector('[aria-current]')?.focus({ preventScroll: true });
  function shut() {
    open?.shut();
    open?.card.remove();
    open = null;
    from.setAttribute('aria-expanded', 'false');
  }
}

// The menu's rows: the day's pages, then the days either side that have pages
function menuOf(book) {
  const all = [...new Set([...book.days, book.today])].sort(),
    before = all.filter(d => d < book.day).at(-1),
    after = all.find(d => d > book.day),
    row = (data, words, current = false) =>
      `<li><button role="menuitem" ${data}${current ? ' aria-current="page"' : ''}>${words}</button></li>`;
  const pages = book.views.map((v, i) =>
      row(`data-i="${i}"`, `<small>${i + 1}</small>${esc(nameOf(v.page))}`, i === book.cur),
    ),
    days = [
      before && row(`data-day="${before}"`, `‹ ${esc(dayName(before, book.today))}`),
      after && row(`data-day="${after}"`, `${esc(dayName(after, book.today))} ›`),
    ].filter(Boolean);
  return `<p class="bk-menu-day">${esc(dayName(book.day, book.today))}</p><ul class="bk-menu">${pages.join('')}</ul>${
    days.length ? `<hr><ul class="bk-menu">${days.join('')}</ul>` : ''
  }`;
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
