// What's picked on an open Notebook page, moved to another open page of its chapter or to a new page at the notebook's
// end, from one list of those pages (pagesCard): Select's Move to page… opens it under its button (bookselectclip.js's
// bar), the Pencil's ring and line out of it over the page bar (bookassign.js). A group picked whole goes as it is,
// with its answers. What's picked of others is lifted out first, where it is, into a unit of its own (bookunits.js
// newUnit). On the other page each is its last unit. Undo moves them back to their places, what was lifted out a unit
// of its own, as a lasso's split. Toasted, a tap there turning to the page. A list card (bookcard.js), its look
// bookmoveto.css.
import { esc, stylesheet } from '../../util.js';
import { toast } from '../toast.js';
import { word } from './bookscope.js';
import { toastHeard } from './booksounds.js';
import { readAgain, saved, shut } from './booksave.js';
import { createPage, moveGroup } from './notebookdata.js';
import { CHAPTER_WORDS } from './notebookchapters.js';
import { nameOf } from './bookhead.js';
import { newUnit } from './bookunits.js';
import { lineIcon } from './bookui.js';
import { cardOf, put } from './bookcard.js';

stylesheet('shell/ink/bookmoveto.css');

const LISTS = ['ink', 'texts', 'scraps'];
const PAGE = lineIcon('<path d="M6 2.5h8l4.5 4.5v14.5h-12.5z"/><path d="M14 2.5v4.5h4.5"/>'),
  ADD = lineIcon('<path d="M12 5v14M5 12h14"/>');
// the list stands this far (px) under the bar's button, or above the page bar, its beak at least this far in from its
// corners
const MENU_GAP_PX = 4,
  OVER_BAR_PX = 16,
  BEAK_IN_PX = 28;

// book: bookpages.js's. hooks: bookgroups.js's. Returns { movable(view), move(view, picked, from), mates(view),
// moveOnto(view, picked, to) }: whether what's picked on a view's page can go to another page, and the list of pages
// for it at the bar's button pressed (from); the open pages of a view's page's chapter, it among them, and what's
// picked moved onto one of them (null: a new page); picked: { ink, scraps, texts } (the page's own elements) and box,
// round them on the page
export function mountMoveTo(book, hooks) {
  const mv = { book, hooks, menu: null };
  return {
    movable: view => !!view?.page.groups && !shut(view.page),
    move: (view, picked, from) => pagesMenu(mv, view, from, picked),
    mates: view => mates(mv, view),
    moveOnto: (view, picked, to) => moveTo(mv, view, picked, to),
  };
}

// The chapter's pages at the button pressed, what's picked going to the one clicked
function pagesMenu(mv, view, from, picked) {
  shutMenu(mv);
  const pages = mates(mv, view),
    card = pagesCard(pages, view.page);
  const r = from.getBoundingClientRect();
  put(card, r.left, r.bottom + MENU_GAP_PX, mv.book.desk.getBoundingClientRect());
  card.addEventListener('click', e => {
    const row = e.target.closest('.bk-row[data-page]');
    if (!row) return;
    shutMenu(mv);
    moveTo(mv, view, picked, pages.find(p => String(p.id) === row.dataset.page) ?? null);
  });
  const away = e => !card.contains(e.target) && !from.contains(e.target) && shutMenu(mv);
  const keys = e => e.key === 'Escape' && (shutMenu(mv), from.focus());
  addEventListener('pointerdown', away, true);
  addEventListener('keydown', keys);
  mv.menu = { card, off: () => (removeEventListener('pointerdown', away, true), removeEventListener('keydown', keys)) };
  card.querySelector('.bk-row[data-page]').focus({ preventScroll: true });
}
function shutMenu(mv) {
  mv.menu?.off();
  mv.menu?.card.remove();
  mv.menu = null;
}

// What's picked onto page to (null: a new one at the notebook's end), both pages read again, Undo a step
async function moveTo(mv, view, picked, to) {
  const { book } = mv,
    from = view.page;
  const go = async (moves, a, b) => {
    await saved(book, a);
    for (const [g, after] of moves) await moveGroup(book.dev, g, b.id, after);
    for (const p of [a, b]) readAgain(book, p);
  };
  let there, back;
  try {
    const ids = await unitsOf(mv, view, picked);
    there = ids.map(id => [id]);
    back = ids.map(id => [id, unitBefore(from, id) ?? 'start']);
    to ??= await pageMade(mv);
    await go(there, from, to);
  } catch (e) {
    return toast(esc(e.message));
  }
  book.steps.push({ page: from, undo: () => go(back, to, from), redo: () => go(there, from, to) });
  toastHeard(word('movedToast', { name: esc(nameOf(to)) }), () => mv.hooks.turnTo(to));
}
// The units what's picked makes, saved, their ids in the page's order: each group picked whole (a unit just drawn
// too), and one lifted out where it is for the rest (its elements' unit changed in place, as booksave.js's own)
async function unitsOf(mv, view, picked) {
  const page = view.page,
    els = LISTS.flatMap(list => picked[list]),
    count = new Map();
  for (const el of els) count.set(el.g, (count.get(el.g) ?? 0) + 1);
  const on = g => LISTS.reduce((n, list) => n + page[list].filter(el => el.g === g).length, 0),
    whole = g => (page.groups.has(g) || g < 0) && on(g) === count.get(g);
  const loose = els.filter(el => !whole(el.g));
  // (its own unit from now on, as a lasso's split: Undo of the move brings it back as that)
  if (loose.length) {
    const id = newUnit(page, picked.box, true);
    for (const el of loose) el.g = id;
    mv.hooks.changed(page);
  }
  await saved(mv.book, page);
  const ids = new Set(els.map(el => el.g));
  return [...page.groups.values()]
    .filter(g => ids.has(g.id))
    .sort((a, b) => a.pos - b.pos)
    .map(g => g.id);
}
// The unit right before unit id in its page's order, its id (undefined: id is the first)
function unitBefore(page, id) {
  const { pos } = page.groups.get(id);
  return [...page.groups.values()].filter(g => g.pos < pos).sort((a, b) => b.pos - a.pos)[0]?.id;
}
// A new page at the notebook's end, among the book's pages (not shown)
async function pageMade(mv) {
  const made = await createPage(mv.book.dev, mv.book.notebook);
  await mv.hooks.pagesAgain();
  return mv.hooks.pages().find(p => p.id === made.id);
}

// The open pages of a view's page's chapter, it among them, in the book's order
const mates = (mv, view) =>
  mv.hooks.pages().filter(p => p.chapter === view.page.chapter && (p === view.page || !shut(p)));

// The pages (of here's chapter, here among them) under Move to a page in <chapter>: each at its name, here's muted as
// this page, then New page under a rule. A row's data-page is its page's id, or new. A card in the book, not yet
// placed.
export function pagesCard(pages, here) {
  const card = cardOf('bk-move-pages', word('moveToPage'));
  const row = (p, i) =>
    `<button type="button" class="bk-row" role="menuitem"${p === here ? ' aria-disabled="true"' : ` data-page="${p.id}"`}
    style="--i:${i}"><span class="bk-page-icon">${PAGE}</span><span class="bk-name">${esc(nameOf(p))}</span>${
      p === here ? `<span class="bk-kind">${word('thisPage')}</span>` : ''
    }</button>`;
  card.innerHTML = `<p class="bk-list-head">${word('moveToChapter', {
    chapter: word(CHAPTER_WORDS[here.chapter]),
  })}</p>${pages.map(row).join('')}<button type="button" class="bk-row bk-list-more" role="menuitem" data-page="new"
    style="--i:${pages.length}"><span class="bk-page-icon">${ADD}</span><span class="bk-name">${word('newPage')}</span>
    </button>`;
  return card;
}
// Over the page bar (its pages' island, a DOMRect), its beak pointing down at the bar's middle (room: as put's)
export function placeOver(card, bar, room) {
  const w = card.offsetWidth;
  put(card, bar.left + bar.width / 2 - w / 2, bar.top - OVER_BAR_PX - card.offsetHeight, room);
  const left = parseFloat(card.style.left);
  card.dataset.beak = '';
  card.style.setProperty(
    '--beak',
    `${Math.round(Math.max(BEAK_IN_PX, Math.min(w - BEAK_IN_PX, bar.left + bar.width / 2 - left)))}px`,
  );
}
