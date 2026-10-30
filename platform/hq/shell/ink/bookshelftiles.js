// The overview's page tiles as HTML (bookshelf.js draws them; a notebook on the Shelf: bookshelfbooks.js), and its
// icons.
import { esc } from '../../util.js';
import { lineIcon as svg } from './bookui.js';
import { untitledPage } from './bookhead.js';

export const ICONS = {
  shelf: svg('<path d="M5 4v16M9.5 4v16"/><path d="M13.6 5.3l3.8-1 3.7 14.4-3.8 1z"/><path d="M3 20.2h18"/>'),
  // (a box with its lid, its handle one stroke, as Ink's other line icons)
  archive: svg(
    '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>',
  ),
  restore: svg('<path d="M5 11v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8"/><path d="M12 16V4.5M8 8.5l4-4 4 4"/>'),
  add: svg('<path d="M12 5v14M5 12h14"/>'),
  // (a book's own menu: three dots.)
  more: svg('<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="3"/>'),
};
// The sent mark: a rubber stamp's ring and its word, inked unevenly on the page's corner (bookpaper.css's grain), pressed
// on with bookpaper.js's stamp as a page is seen to go
const SENT_MARK =
  '<svg class="bk-stamp bk-stamped" viewBox="0 0 96 40" aria-hidden="true"><rect x="2" y="2" width="92" height="36" rx="7"/><rect x="6.5" y="6.5" width="83" height="27" rx="4"/><text x="48" y="27.6" text-anchor="middle">SENT</text></svg>';

// A page's tile: its picture (a grown page's top), its stamp once sent, its number and title; its small box archives
// it or brings it back
export function pageTile(p, i, { here, drag = false, archived = false, manage = true }) {
  const name = p.title || untitledPage(),
    // (a call's notes page goes in and to nobody: no stamp.)
    said = `${name}${p.kind === 'call' ? '' : p.sent ? ', sent' : p.sending ? ', sending' : ''}`;
  return `<div class="bk-tile" role="listitem" data-id="${esc(p.id)}"${drag ? ' data-drag' : ''}${
    String(p.id) === String(here) ? ' aria-current="page"' : ''
  }><button type="button" class="bk-tile-open" aria-label="${esc(said)}"><span class="bk-tile-paper">${
    p.picture ? `<img src="${esc(p.picture)}" alt="" draggable="false">` : ''
  }${(p.sent || p.sending) && p.kind !== 'call' ? SENT_MARK.replace('bk-stamp', `bk-stamp${p.sent ? '' : ' bk-stamp-wet'}`) : ''}</span><span class="bk-tile-name">${
    archived ? '' : `<small>${i + 1}</small>`
  }<span>${esc(p.title)}</span></span></button>${
    manage
      ? `<button type="button" class="bk-tile-act" data-act="${
          archived ? 'restore' : 'archive'
        }" aria-label="${archived ? 'Back into the notebook' : 'Archive'}: ${esc(name)}">${
          archived ? ICONS.restore : ICONS.archive
        }</button>`
      : ''
  }</div>`;
}
