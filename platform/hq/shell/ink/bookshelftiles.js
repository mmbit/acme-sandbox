// The overview's pages as HTML, under their chapters' plain heads (bookshelf.js draws them; a notebook on the Shelf:
// bookshelfbooks.js), and its icons.
import { esc } from '../../util.js';
import { lineIcon as svg } from './bookui.js';
import { dayName, untitledPage } from './bookhead.js';
import { word } from './bookscope.js';
import { CHAPTER_WORDS, tabsOf } from './notebookchapters.js';

export const ICONS = {
  // (the way up: a chevron, as the page's arrows)
  up: svg('<path d="M14.5 5.5L8 12l6.5 6.5"/>'),
  more: svg('<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>'),
  // (a box with its lid, its handle one stroke, as Ink's other line icons)
  archive: svg(
    '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>',
  ),
  restore: svg('<path d="M5 11v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8"/><path d="M12 16V4.5M8 8.5l4-4 4 4"/>'),
  cover: svg(
    '<rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="9.5" cy="9.5" r="1.8"/><path d="M5 18l5-5 3 3 2.5-2.5L20 18"/>',
  ),
  round: svg('<path d="M4 7h16v12H4z"/><path d="M4 7l8 6 8-6"/>'),
  add: svg('<path d="M12 5v14M5 12h14"/>'),
};
// The sent mark: a rubber stamp's ring and its word, inked unevenly on the page's corner (bookpaper.css's grain), pressed
// on with bookpaper.js's stamp as a page is seen to go
const SENT_MARK =
  '<svg class="bk-stamp bk-stamped" viewBox="0 0 96 40" aria-hidden="true"><rect x="2" y="2" width="92" height="36" rx="7"/><rect x="6.5" y="6.5" width="83" height="27" rx="4"/><text x="48" y="27.6" text-anchor="middle">SENT</text></svg>';

// A page's tile: its picture (a grown page's top) lying on the paper, its stamp once sent, its title and day under it;
// an archived one's small box brings it back
export function pageTile(p, { here, drag = false, archived = false }) {
  const name = p.title || untitledPage(),
    // (a call's notes page goes in and to nobody: no stamp.)
    said = `${name}${p.kind === 'call' ? '' : p.sent ? ', sent' : p.sending ? ', sending' : ''}`;
  return `<div class="bk-tile" role="listitem" data-id="${esc(p.id)}"${drag ? ' data-drag' : ''}${
    String(p.id) === String(here) ? ' aria-current="page"' : ''
  }><button type="button" class="bk-tile-open" aria-label="${esc(said)}"><span class="bk-tile-paper">${
    p.picture ? `<img src="${esc(p.picture)}" alt="" draggable="false">` : ''
  }${(p.sent || p.sending) && p.kind !== 'call' ? SENT_MARK.replace('bk-stamp', `bk-stamp${p.sent ? '' : ' bk-stamp-wet'}`) : ''}</span><span class="bk-tile-name"><span>${esc(
    p.title,
  )}</span>${p.day ? `<small class="bk-tile-day">${esc(dayName(p.day))}</small>` : ''}</span></button>${
    archived
      ? `<button type="button" class="bk-tile-act" data-act="restore" aria-label="Back into the notebook: ${esc(name)}">${ICONS.restore}</button>`
      : ''
  }</div>`;
}

// A notebook's pages split as the book is: each of its chapters in the book's order under a plain head (a small ribbon
// in its bookmark's colour, bookmarks.css; its name; its count), then its pages' grid (a page dragged moves within its
// chapter); a chapter with no pages yet a word. book: the notebook ({ kind, round }); here: the page shown (its id);
// adds: New page at Sketch's end.
export function chapterGrids(book, pages, { here, drag, adds }) {
  return tabsOf(book)
    .map(c => {
      const in_ = pages.filter(p => p.chapter === c),
        add = adds && c === 'sketch',
        count = in_.length === 1 ? word('onePage') : word('pageCount', { n: in_.length });
      return `<section class="bk-far-chapter" data-chapter="${c}" role="presentation"><h3 class="bk-far-mark"><i class="bk-far-ribbon" data-chapter="${c}" aria-hidden="true"></i><span>${esc(
        word(CHAPTER_WORDS[c]),
      )}</span><small>${esc(count)}</small></h3>${
        in_.length || add
          ? `<div class="bk-grid" data-grid="pages" data-chapter="${c}" role="presentation">${in_
              .map(p => pageTile(p, { here, drag }))
              .join('')}${add ? newTile() : ''}</div>`
          : `<p class="bk-far-none bk-far-empty">${esc(word('noPages'))}</p>`
      }</section>`;
    })
    .join('');
}
const newTile = () =>
  `<div class="bk-tile bk-tile-new" role="listitem"><button type="button" class="bk-tile-open" data-new aria-label="${word('newPage')}"><span class="bk-tile-paper">${ICONS.add}</span><span class="bk-tile-name"><span>${word('newPage')}</span></span></button></div>`;
