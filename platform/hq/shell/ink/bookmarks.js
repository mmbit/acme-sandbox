// A book's chapters as its bookmarks, the board's on every book of its own (notebookchapters.js): Sketch, Asks and Calls,
// or a round's (notebookrounds.ts) Guests, Asks and Advice (once the round is done). Upright they stand along the
// book's top, its page trimmed to make room under Safari's blurred strip; sideways they peek out of a thick white
// stack of page edges at the book's left (bookmarks.css). The chapter shown is lit; Asks has a red count of the asks
// still open. A tab opens the first page of its chapter; one with no pages yet shows, dim, and opens an empty page of its
// own, its chapter's name at its head, till another page or tab is chosen (it
// said so in a toast). A round's
// Guests tab also opens a short list of its guests, one line each with how far their page is (nothing yet, its notes,
// done), a tap opening their page.
import { esc } from '../../util.js';
import { foley } from '../audio.js';
import { word } from './bookscope.js';
import { chaptersOf } from './notebookchapters.js';
import { loadPages } from './notebookdata.js';

const TITLES = { sketch: 'Sketch', asks: 'Asks', calls: 'Calls', guests: 'Guests', advice: 'Advice' };
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
  const s = { pages, book: null, list: [], notebook: null, asked: 0, timer: 0 };
  leaf.closest('#book').classList.add('bk-marked');
  s.nav = Object.assign(document.createElement('nav'), { className: 'bk-marks' });
  s.nav.setAttribute('aria-label', word('Chapters'));
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

// The tabs as the notebook and the page shown are now, and a round's guests' list
function draw(s) {
  if (!s.book) return;
  const shown = s.pages.page(),
    { round } = s.book;
  s.nav.innerHTML = chaptersOf(s.book.kind)
    .filter(c => c !== 'advice' || round?.state === 'done')
    .map(c => tab(s, c, s.empty ? s.empty.chapter === c : shown?.chapter === c))
    .join('');
  if (!round) return void (s.panel.hidden = true);
  s.panel.innerHTML = round.guests.length
    ? round.guests.map(guestLine).join('')
    : `<p class="bk-mk-empty">${esc(word('No guests yet'))}</p>`;
}
function tab(s, chapter, current) {
  const open = chapter === 'asks' ? (s.book.round?.asksOpen ?? s.book.asks?.open ?? 0) : 0;
  const count = open > 0 ? `<b class="bk-mk-count">${open}</b>` : '';
  const label = count ? `${word('Asks')}, ${word('{n} open', { n: open })}` : word(TITLES[chapter]);
  const empty = !firstOf(s, chapter) && chapter !== 'guests';
  return `<button type="button" data-chapter="${chapter}" aria-label="${esc(label)}"${
    current ? ' aria-current="page"' : ''
  }${empty ? ' data-empty' : ''}><span>${esc(word(TITLES[chapter]))}</span>${count}</button>`;
}
// A tab tapped: its chapter's first page (a round's guests' list opened or closed too), or a word that it has none yet
function tapped(s, chapter) {
  if (!chapter) return;
  s.panel.hidden = chapter !== 'guests' || !s.panel.hidden;
  const first = firstOf(s, chapter);
  emptied(s, first || chapter === 'guests' ? null : chapter);
  if (first) return first.id !== s.pages.page()?.id && s.pages.show(first.id);
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
    done: () => word('done'),
    some: () => (g.notes === 1 ? word('1 note') : word('{n} notes', { n: g.notes })),
    none: () => word('nothing yet'),
  }[state]();
  const name = g.name || word('A guest');
  return `<button type="button" class="bk-mk-guest" data-page="${Number(g.page) || ''}" data-name="${esc(name)}">
    <span class="bk-mk-initial" aria-hidden="true">${esc([...name][0].toLocaleUpperCase())}</span>
    <span class="bk-mk-name">${esc(name)}</span>
    <span class="bk-mk-state bk-mk-${state}">${esc(said)}<svg viewBox="0 0 16 16" aria-hidden="true">${MARKS[state]}</svg></span>
  </button>`;
}
