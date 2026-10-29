// The overview's tiles as HTML (bookshelf.js draws them): a notebook's page, a notebook on the Shelf, and the day a
// notebook last changed.
import { DAYS, MONTHS, esc } from '../../util.js';
import { lineIcon as svg } from './bookui.js';
import { untitledPage } from './bookhead.js';

// what a notebook's label says it is, under its name (My Notebook says nothing; a call's notes are a page of it.
const KINDS = { round: 'Review round', invited: 'Invited' };

export const ICONS = {
  shelf: svg('<path d="M5 4v16M9.5 4v16"/><path d="M13.6 5.3l3.8-1 3.7 14.4-3.8 1z"/><path d="M3 20.2h18"/>'),
  // (a box with its lid, its handle one stroke, as Ink's other line icons)
  archive: svg(
    '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>',
  ),
  restore: svg('<path d="M5 11v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8"/><path d="M12 16V4.5M8 8.5l4-4 4 4"/>'),
  add: svg('<path d="M12 5v14M5 12h14"/>'),
};
// The sent mark: a rubber stamp's ring and its word, inked unevenly on the page's corner (bookpaper.css's grain), pressed
// on with bookpaper.js's stamp as a page is seen to go
const SENT_MARK =
  '<svg class="bk-stamp bk-stamped" viewBox="0 0 96 40" aria-hidden="true"><rect x="2" y="2" width="92" height="36" rx="7"/><rect x="6.5" y="6.5" width="83" height="27" rx="4"/><text x="48" y="27.6" text-anchor="middle">SENT</text></svg>';

// A page's tile: its picture (a grown page's top), its stamp once sent, its number and title; its small box archives
// it or brings it back
export function pageTile(p, i, { here, drag = false, archived = false, manage = true }) {
  const name = p.title || untitledPage(),
    said = `${name}${p.sent ? ', sent' : p.sending ? ', sending' : ''}`;
  return `<div class="bk-tile" role="listitem" data-id="${esc(p.id)}"${drag ? ' data-drag' : ''}${
    String(p.id) === String(here) ? ' aria-current="page"' : ''
  }><button type="button" class="bk-tile-open" aria-label="${esc(said)}"><span class="bk-tile-paper">${
    p.picture ? `<img src="${esc(p.picture)}" alt="" draggable="false">` : ''
  }${p.sent || p.sending ? SENT_MARK.replace('bk-stamp', `bk-stamp${p.sent ? '' : ' bk-stamp-wet'}`) : ''}</span><span class="bk-tile-name">${
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

// A notebook's tile: a small black hardcover, its name on a paper label, what it is under it; the one open in the book
// with a ribbon in the book's accent; its page count and last change under it
export function bookTile(n, here) {
  const count = `${n.pages} ${n.pages === 1 ? 'page' : 'pages'}`;
  return `<div class="bk-tile bk-book" role="listitem" data-book="${esc(n.id)}" data-kind="${esc(n.kind)}"${
    here ? ' aria-current="true"' : ''
  }><button type="button" class="bk-tile-open" aria-label="${esc(n.name)}, ${count}"><span class="bk-cover">${
    here ? '<i class="bk-ribbon"></i>' : ''
  }<span class="bk-cover-label"><b>${esc(n.name)}</b>${
    KINDS[n.kind] ? `<small>${KINDS[n.kind]}</small>` : ''
  }</span></span><span class="bk-tile-name"><span>${count}</span><small>${esc(when(n.updated))}</small></span></button>${
    n.kind === 'mine'
      ? ''
      : `<button type="button" class="bk-tile-act" data-act="${n.archived ? 'restore' : 'archive'}" aria-label="${
          n.archived ? 'Back on the Shelf' : 'Archive'
        }: ${esc(n.name)}">${n.archived ? ICONS.restore : ICONS.archive}</button>`
  }</div>`;
}
// A last change as the book names a day: Today, Yesterday, "Mon 26 Oct" (a day or a time)
function when(t) {
  if (!t) return '';
  const d = new Date(/^\d{4}-\d\d-\d\d$/.test(t) ? `${t}T12:00:00` : t),
    now = new Date(),
    ago = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (Number.isNaN(ago)) return '';
  return ago === 0 ? 'Today' : ago === 1 ? 'Yesterday' : `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
