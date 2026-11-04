// A book's chapters as its bookmarks, the board's on every book of its own (notebookchapters.js): Sketch, Asks and
// Calls, or a round's (notebookrounds.ts) Guests, Asks and Advice (once the round is done). Real bookmarks (README, The
// book's frame): each keeps one card colour for good and never lights up; the
// page's own chapter shows by depth, its tab out of the block's top page, nearest the page and a little longer, the
// others from deeper in. Beside HQ's page they stick out of the page block at the book's outer edge; on a page that is
// the whole screen (a phone, an iPad upright) they stick out of it the same while the book swings, and once it has
// landed they lie folded against its left edge like the pull tab, slivers alike with their icons, and a tap or a pull
// brings them out over the margin (README, Bookmarks). They live on the cover's
// edge (book.js), so they move and swing with the book (bookmarks.css). Asks carries the count of the asks still open
// ("Asks · 2"). A tab opens the page its chapter was last on, at first its first page, and the page's own its first
// page (over the overview, its chapter there); one with no pages yet opens an empty page of its own, its chapter's
// name at its head, till another page or tab is chosen.
// A round's Guests tab also opens a short list of its guests, one line each with how far their page is (nothing yet,
// its notes, done), a tap opening their page.
import { esc } from '../../util.js';
import { foley } from '../audio.js';
import { word } from './bookscope.js';
import { CHAPTER_WORDS as TITLES, tabsOf } from './notebookchapters.js';
import { loadPages } from './notebookdata.js';

// circle marks on a 16 px square: nothing yet, some notes, done
const MARKS = {
  none: '<circle cx="8" cy="8" r="6.5"/>',
  some: '<circle cx="8" cy="8" r="6.5"/><path d="M8 1.5a6.5 6.5 0 0 1 0 13z" class="bk-mk-fill"/>',
  done: '<circle cx="8" cy="8" r="6.5"/><path d="M5 8.3l2.1 2.1L11.2 6"/>',
};
// how long the store's changes settle before the notebook is read again
const SETTLE_MS = 300;
// a pull on the folded tabs this far to the right brings them out (less: a tap)
const PULL_PX = 10;
// Each chapter's icon on its tab, in the controls' line on a 24 px square
const ICONS = {
  sketch: '<path d="M3 15c2.5-5 4.5-5 6 0s3.5 5 6 0 3.5-5 6 0"/>',
  asks: '<path d="M4 5h16v11H10l-5 4v-4H4z"/><path d="M10 9.2a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.5"/><path d="M12 14.2v.1"/>',
  calls:
    '<path d="M6.5 3.5h3l1.8 4.6-2.3 1.4a10.5 10.5 0 0 0 5.5 5.5l1.4-2.3 4.6 1.8v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2z"/>',
  guests: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  advice:
    '<path d="M9.5 18h5M10.5 21h3"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3z"/>',
};
const icon = chapter =>
  `<svg class="bk-mk-icon" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[chapter]}</g></svg>`;
// Whether the tabs lie folded at the page's left edge (the page the whole screen: data-whole on #book, set by book.js
// from where the book's going; the book landed) rather than out of the page block (beside HQ's page, an upright iPad's
// too, or while the book swings): bookmarks.css's split
const folded = s => s.root.hasAttribute('data-whole') && s.root.dataset.mode === 'spread';

// parts: the book's (book.js): the tabs on its cover's edge, a round's guests' list and a chapter's empty page on its
// leaf. pages: what the book asks of its pages (bookpages.js's: page(), show(id), dev). The tabs follow the page shown
// by its leaf turning (a page's element shown or hidden), and read the notebook again when the store says it changed
// (book:notebook, book:changed).
export function mountBookmarks({ edge, leaf }, pages) {
  const s = {
    pages,
    root: leaf.closest('#book'),
    book: null,
    list: [],
    notebook: null,
    asked: 0,
    timer: 0,
    kept: new Map(),
  };
  s.root.classList.add('bk-marked');
  s.nav = Object.assign(document.createElement('nav'), { className: 'bk-marks' });
  s.nav.setAttribute('aria-label', word('chapters'));
  s.nav.setAttribute('data-keep-clear', ''); // (a minimised call keeps clear of the tabs.)
  s.nav.setAttribute('data-no-ink', '');
  s.panel = Object.assign(document.createElement('div'), { className: 'bk-mk-guests', hidden: true });
  s.blank = Object.assign(document.createElement('div'), { className: 'bk-mk-blank', hidden: true });
  edge.append(s.nav);
  leaf.append(s.panel, s.blank);
  // (their height, which the book's pull tab keeps below: book.css.)
  const book = leaf.closest('#book');
  new ResizeObserver(() => book.style.setProperty('--bk-marks-h', `${s.nav.offsetHeight}px`)).observe(s.nav);
  s.nav.addEventListener('click', e => tapped(s, e.target.closest('[data-chapter]')?.dataset.chapter));
  pulling(s);
  s.panel.addEventListener('click', e => chose(s, e.target.closest('[data-name]')));
  // (a tap anywhere else lets the list go, and folds the tabs away)
  document.addEventListener('pointerdown', e => {
    if (e.target.closest?.('.bk-mk-guests, .bk-marks')) return;
    s.panel.hidden = true;
    out(s, false);
  });
  const later = () => (clearTimeout(s.timer), (s.timer = setTimeout(() => read(s), SETTLE_MS)));
  for (const type of ['book:notebook', 'book:changed']) document.addEventListener(type, later);
  new MutationObserver(() => {
    // (another page turned to: the empty chapter's page let go)
    if (s.empty && pages.page()?.id !== s.empty.over) emptied(s, null);
    return pages.page()?.notebook !== s.notebook ? read(s) : draw(s);
  }).observe(leaf.querySelector('.bk-world'), { subtree: true, attributeFilter: ['hidden'] });
}

// The notebook of the page shown read again: its kind, open asks and round, and its pages' chapters, the latest read
// winning
async function read(s) {
  const shown = s.pages.page(),
    mine = ++s.asked;
  s.notebook = shown?.notebook ?? null;
  if (!s.notebook) return;
  let got;
  try {
    got = await loadPages(s.pages.dev, s.notebook);
  } catch {
    return; // (the tabs stay as they were till the next read)
  }
  if (mine !== s.asked) return;
  const round = got.notebook.round;
  Object.assign(s, {
    book: { ...got.notebook, round: round && { ...round, guests: round.guests ?? [] } },
    list: got.pages,
  });
  draw(s);
}
const firstOf = (s, chapter) => s.list.find(p => p.chapter === chapter);
// (each notebook's chapters' pages last shown, by "notebook chapter")
const keptKey = (notebook, chapter) => `${notebook} ${chapter}`;
// The page a chapter was last on, while it's still in it, else its first
const pageOf = (s, chapter) =>
  s.list.find(p => p.chapter === chapter && p.id === s.kept.get(keptKey(s.notebook, chapter))) ?? firstOf(s, chapter);

// The tabs as the notebook and the page shown are now, and a round's guests' list
function draw(s) {
  const shown = s.pages.page();
  if (shown?.chapter && !s.empty) s.kept.set(keptKey(shown.notebook, shown.chapter), shown.id);
  if (!s.book) return;
  const { round } = s.book;
  drawn(
    s.nav,
    tabsOf(s.book)
      .map(c =>
        chapterTab(s.book, c, {
          here: s.empty ? s.empty.chapter === c : shown?.chapter === c,
          empty: !firstOf(s, c) && c !== 'guests',
        }),
      )
      .join(''),
  );
  if (!round) return void (s.panel.hidden = true);
  drawn(
    s.panel,
    round.guests.length ? round.guests.map(guestLine).join('') : `<p class="bk-mk-empty">${esc(word('noGuests'))}</p>`,
  );
}
// el's markup made html, unless it's that already: the tabs are drawn again whenever anything in the book is shown or
// hidden (a page saved writes its refusal line's hidden), and a tab made anew between a tap's press and its release
// loses the tap
function drawn(el, html) {
  if (el.html !== html) el.innerHTML = el.html = html;
}
// A chapter's tab, a bookmark or the overview's (bookshelftiles.js), in its own card colour (bookmarks.css
// .bk-mk-tab[data-chapter]): its icon and name, Asks with the count of the asks still open ("Asks · 2"), marked
// (aria-current, never lit) where the page shown is, data-empty with no pages yet. tag:
// a bookmark's 'button', or the overview's heading
export function chapterTab(book, chapter, { here, empty, tag = 'button' }) {
  const open = chapter === 'asks' ? (book.round?.asksOpen ?? book.asks?.open ?? 0) : 0,
    name = word(TITLES[chapter]),
    label = open > 0 ? `${name}, ${word('openCount', { n: open })}` : name,
    count = open > 0 ? `<b class="bk-mk-count"> · ${open}</b>` : '',
    buttonAttributes = tag === 'button' ? ' type="button"' : '',
    flagAttributes = `${here ? ' aria-current="page"' : ''}${empty ? ' data-empty' : ''}`,
    opening = `<${tag} class="bk-mk-tab" data-chapter="${chapter}"${buttonAttributes} aria-label="${esc(label)}"${flagAttributes}>`;
  return `${opening}${icon(chapter)}<span>${esc(name)}${count}</span></${tag}>`;
}
// The folded tabs out over the page's margin, or folded away again (on); beside HQ's page they're always out
function out(s, on) {
  s.nav.toggleAttribute('data-out', on && folded(s));
}
// A pull to the right on the folded tabs brings them out, as a tap on them does; never the cover's edge's resize
// (book.js) nor the page's (its press is the tabs')
function pulling(s) {
  s.nav.addEventListener('pointerdown', e => {
    if (!e.isPrimary || s.nav.hasAttribute('data-out') || !folded(s)) return;
    const x0 = e.clientX,
      move = m => m.pointerId === e.pointerId && m.clientX - x0 > PULL_PX && (stop(), out(s, true)),
      stop = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', stop);
        removeEventListener('pointercancel', stop);
      };
    addEventListener('pointermove', move);
    addEventListener('pointerup', stop);
    addEventListener('pointercancel', stop);
  });
}
// A tab tapped: the page its chapter was last on, or its first where it's the page's own (a round's guests' list opened or closed
// too), or a word that it has none yet
function tapped(s, chapter) {
  if (!chapter) return;
  // (folded, a tap brings them out first: the slivers are too small to pick one by)
  if (folded(s) && !s.nav.hasAttribute('data-out')) return out(s, true);
  out(s, false);
  // (over the notebook's pages, its overview: there it's scrolled to, bookshelf.js)
  if (s.nav.closest('#book').dataset.far)
    return document.dispatchEvent(new CustomEvent('book:chapter', { detail: { chapter } }));
  s.panel.hidden = chapter !== 'guests' || !s.panel.hidden;
  const here = !s.empty && s.pages.page()?.chapter === chapter,
    to = here ? firstOf(s, chapter) : pageOf(s, chapter);
  emptied(s, to || chapter === 'guests' ? null : chapter);
  if (to) return to.id !== s.pages.page()?.id && s.pages.show(to.id);
  if (chapter !== 'guests') foley('slide', { dur: 0.12, material: 'paper', size: 0.3 }, { vol: 0.15 });
}
// A chapter's empty page over the page shown (null: let go), its tab the page's own
function emptied(s, chapter) {
  s.empty = chapter && { chapter, over: s.pages.page()?.id };
  s.blank.hidden = !chapter;
  s.blank.innerHTML = chapter ? `<h2>${esc(word(TITLES[chapter]))}</h2>` : '';
  draw(s);
}
// A guest chosen from the list: their page, by its id or by their name on it
function chose(s, line) {
  if (!line) return;
  s.panel.hidden = true;
  const id = Number(line.dataset.page),
    page = s.list.find(p => (id && p.id === id) || (p.guest && p.guest === line.dataset.name));
  if (page) s.pages.show(page.id);
}

// A guest's line: their initial in a circle, their name, and how far their page is
function guestLine(g) {
  const state = g.done ? 'done' : g.notes > 0 ? 'some' : 'none';
  const said = {
    done: () => word('guestDone'),
    some: () => (g.notes === 1 ? word('guestOneNote') : word('guestNotes', { n: g.notes })),
    none: () => word('guestNothingYet'),
  }[state]();
  const name = g.name || word('aGuest');
  return `<button type="button" class="bk-mk-guest" data-page="${Number(g.page) || ''}" data-name="${esc(name)}">
    <span class="bk-mk-initial" aria-hidden="true">${esc([...name][0].toLocaleUpperCase())}</span>
    <span class="bk-mk-name">${esc(name)}</span>
    <span class="bk-mk-state bk-mk-${state}">${esc(said)}<svg viewBox="0 0 16 16" aria-hidden="true">${MARKS[state]}</svg></span>
  </button>`;
}
