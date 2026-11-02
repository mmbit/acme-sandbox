// A book's chapters as its bookmarks, the board's on every book of its own (notebookchapters.js): Sketch, Asks and Calls,
// or a round's (notebookrounds.ts) Guests, Asks and Advice (once the round is done). They stand along the book's top,
// its page trimmed to make room under Safari's blurred strip, wherever the screen is tall enough; sideways on a short
// screen they peek out of a thick white stack of page edges at the book's left (bookmarks.css). The chapter shown is
// lit; Asks has a red count of the asks still open. A tab opens the page its chapter was last on, at first its first
// page, and the lit tab its first page; one with no pages yet shows, dim, and
// opens an empty page of its own, its chapter's name at its head, till another page or tab is chosen (it said so in a
// toast). A round's Guests tab also opens a short list of its guests, one line each with how far their page is
// (nothing yet, its notes, done), a tap opening their page.
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

// leaf: the book's leaf (book.js). pages: what the book asks of its pages (bookpages.js's: page(), show(id), dev).
// The tabs follow the page shown by its leaf turning (a page's element shown or hidden), and read the notebook again
// when the store says it changed (book:notebook, book:changed). The book has its tabs' room from the start, so nothing
// moves as they're read.
export function mountBookmarks(leaf, pages) {
  const s = { pages, book: null, list: [], notebook: null, asked: 0, timer: 0, kept: new Map() };
  leaf.closest('#book').classList.add('bk-marked');
  s.nav = Object.assign(document.createElement('nav'), { className: 'bk-marks' });
  s.nav.setAttribute('aria-label', word('chapters'));
  s.nav.setAttribute('data-keep-clear', ''); // (a minimised call keeps clear of the tabs.)
  s.panel = Object.assign(document.createElement('div'), { className: 'bk-mk-guests', hidden: true });
  s.blank = Object.assign(document.createElement('div'), { className: 'bk-mk-blank', hidden: true });
  leaf.append(s.nav, s.panel, s.blank);
  s.nav.addEventListener('click', e => tapped(s, e.target.closest('[data-chapter]')?.dataset.chapter));
  s.panel.addEventListener('click', e => chose(s, e.target.closest('[data-name]')));
  // (a tap anywhere else lets the list go)
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest?.('.bk-mk-guests, .bk-marks')) s.panel.hidden = true;
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
          lit: s.empty ? s.empty.chapter === c : shown?.chapter === c,
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
// A chapter's tab, a bookmark or the overview's (bookshelftiles.js), in the bookmarks' paper (bookmarks.css
// .bk-mk-tab): its name, Asks with its red count of the asks still open, lit where the page shown is, dim with no
// pages yet. tag: a bookmark's 'button' (its chapter in data-chapter), or the overview's heading
export function chapterTab(book, chapter, { lit, empty, tag = 'button' }) {
  const open = chapter === 'asks' ? (book.round?.asksOpen ?? book.asks?.open ?? 0) : 0,
    name = word(TITLES[chapter]),
    label = open > 0 ? `${name}, ${word('openCount', { n: open })}` : name,
    count = open > 0 ? `<b class="bk-mk-count">${open}</b>` : '',
    buttonAttributes = tag === 'button' ? ` type="button" data-chapter="${chapter}"` : '',
    flagAttributes = `${lit ? ' aria-current="page"' : ''}${empty ? ' data-empty' : ''}`,
    opening = `<${tag} class="bk-mk-tab"${buttonAttributes} aria-label="${esc(label)}"${flagAttributes}>`;
  return `${opening}<span>${esc(name)}</span>${count}</${tag}>`;
}
// A tab tapped: the page its chapter was last on, or its first where it's lit (a round's guests' list opened or closed
// too), or a word that it has none yet
function tapped(s, chapter) {
  if (!chapter) return;
  s.panel.hidden = chapter !== 'guests' || !s.panel.hidden;
  const lit = !s.empty && s.pages.page()?.chapter === chapter,
    to = lit ? firstOf(s, chapter) : pageOf(s, chapter);
  emptied(s, to || chapter === 'guests' ? null : chapter);
  if (to) return to.id !== s.pages.page()?.id && s.pages.show(to.id);
  if (chapter !== 'guests') foley('slide', { dur: 0.12, material: 'paper', size: 0.3 }, { vol: 0.15 });
}
// A chapter's empty page over the page shown (null: let go), its tab lit
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
