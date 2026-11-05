// The overview's pages as HTML, under their chapters' plain heads (bookshelf.js draws them; a notebook on the Shelf:
// bookshelfbooks.js), and its icons.
import { esc } from '../../util.js';
import { icon } from '../icons.js';
import { dayName, untitledPage } from './bookhead.js';
import { word } from './bookscope.js';
import { CHAPTER_WORDS, tabsOf } from './notebookchapters.js';

// (HQ's icons, each drawn in the look's own style: icons.js)
export const ICONS = {
  up: icon('back'),
  more: icon('more'),
  archive: icon('box'),
  restore: icon('restore'),
  cover: icon('picture'),
  round: icon('mail'),
  add: icon('plus'),
};
// The sent mark: a rubber stamp's ring and its word, inked unevenly on the page's corner (bookpaper.css's grain), pressed
// on with bookpaper.js's stamp as a page is seen to go
const SENT_MARK =
  '<svg class="bk-stamp bk-stamped" viewBox="0 0 96 40" aria-hidden="true"><rect x="2" y="2" width="92" height="36" rx="7"/><rect x="6.5" y="6.5" width="83" height="27" rx="4"/><text x="48" y="27.6" text-anchor="middle">SENT</text></svg>';

// A page's tile: its picture (a grown page's top) lying on the paper, its stamp once sent, its title and day under it
// (a call's has its day in its title);
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
  )}</span>${
    // (a call's title starts with its day and time: no second date under it, as the view's head)
    p.day && p.kind !== 'call' ? `<small class="bk-tile-day">${esc(dayName(p.day))}</small>` : ''
  }</span></button>${
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
