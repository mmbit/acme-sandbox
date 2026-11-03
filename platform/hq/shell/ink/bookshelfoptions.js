// A notebook's options, from the dots on its overview's title line (bookshelf.js): Change cover (bookshelfcover.js),
// Archived pages with their count (shown under its chapters, or put away again), an open review round's Close the
// round (asking first while asks are open, bookshelfround.js), and for any book but My journal Archive this book, or
// Back on the Shelf once it's archived, Undo a tap away.
import { esc } from '../../util.js';
import { word } from './bookscope.js';
import { archiveNotebook } from './notebookdata.js';
import { ICONS } from './bookshelftiles.js';
import { told } from './bookshelftold.js';

// The options' menu under the title line, while it's open. book: the notebook; archived: its archived pages' count.
export function optionsMenu(s, book, archived) {
  if (!s.menu || !book) return '';
  const round = book.round?.state === 'open',
    rows = [
      ['data-opt="cover"', ICONS.cover, 'Change cover'],
      [
        `data-opt="archived" role="menuitemcheckbox" aria-checked="${s.archived}"`,
        ICONS.archive,
        `${esc(word('archivedPages'))}<small>${archived}</small>`,
      ],
      ...(round ? [['data-opt="close"', ICONS.round, 'Close the round']] : []),
      // (an open round too: its guests write on in the Archive)
      ...(book.kind === 'mine'
        ? []
        : [
            book.archived
              ? ['data-opt="restore"', ICONS.restore, 'Back on the Shelf']
              : ['data-opt="archive"', ICONS.archive, 'Archive this book'],
          ]),
    ];
  return `<div class="bk-far-menu" role="menu" aria-label="${esc(`Options: ${book.name}`)}">${rows
    .map(([data, icon, words]) => `<button type="button" role="menuitem" ${data}>${icon}<span>${words}</span></button>`)
    .join('')}${s.asking?.id === book.id ? roundAsk(book.round.asksOpen) : ''}</div>`;
}
// Its close asked first while asks are open: their count, Close anyway or Not yet
const roundAsk = open =>
  `<div class="bk-round-ask" role="alertdialog" aria-label="Close the round"><p>${esc(
    `${open} ${open === 1 ? 'ask' : 'asks'} still open: close anyway?`,
  )}</p><span><button type="button" data-round="anyway">Close</button><button type="button" data-round="keep">Not yet</button></span></div>`;

// A tap on the title line's dots or in the menu: the dots open or shut it; a row does its part; a tap anywhere else
// shuts it, and does nothing more. Whether the tap's done with. book: the notebook shown.
export function optionTapped(s, t, book) {
  const dots = t.closest('.bk-far-more'),
    row = t.closest('.bk-far-menu [data-opt], .bk-far-menu [data-round]');
  if (!dots && !s.menu) return false;
  if (row?.dataset.round) {
    s.rounded(book, row.dataset.round);
    return true;
  }
  if (t.closest('.bk-far-menu') && !row) return true;
  s.menu = !!dots && !s.menu;
  if (!s.menu) s.asking = null;
  const opt = row?.dataset.opt;
  if (opt === 'archived') s.archived = !s.archived;
  // (Close the round keeps the menu open: its question asks there)
  if (opt === 'close') {
    s.menu = true;
    s.rounded(book, 'close');
  }
  s.ui.draw();
  if (opt === 'cover') s.cover(book);
  if (opt === 'archive' || opt === 'restore') putAway(s, book, opt === 'archive');
  if (s.menu) s.head.querySelector('.bk-far-menu [role^=menuitem]')?.focus();
  return true;
}

// A notebook archived or back on the Shelf: so at once, the store's word after, Undo a tap away
async function putAway(s, book, archived) {
  book.archived = archived;
  s.ui.draw();
  told(s, archived ? `${book.name} archived.` : `${book.name} back on the Shelf.`, () => putAway(s, book, !archived));
  try {
    await archiveNotebook(s.dev, book.id, archived);
  } catch (e) {
    told(s, e.message);
  }
  s.ui.refresh();
}
