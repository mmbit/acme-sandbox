// The Shelf's books as HTML (bookshelf.js draws them in rows, each row on its shelf board; bookshelfbooks.css): each
// the notebook itself standing up, its black cloth cover, its spine at its left and its pages' edges at its right, the
// picture the board or its project gave it pasted on its front, and a paper label with its name and one line of news
//;
// its asks counted on its corner; its own small menu (Change cover, Close the round, Archive or Back on the Shelf). A review round away to
// the CEO, or back, is its brown envelope standing there instead.
import { esc } from '../../util.js';
import { ICONS } from './bookshelftiles.js';

// a book quiet this long reads "quiet this week"
const QUIET_MS = 7 * 864e5;

// The Shelf's books in rows of cols, each row a shelf board under its books; a round away or back in its envelope on
// a board of its own under them, as the deck's shelf. opts: a book's (shelfBook's).
export function shelfRows(books, cols, opts) {
  const wrapped = n => n.kind === 'round' && ['away', 'back'].includes(n.round?.state),
    rows = [];
  for (const part of [books.filter(n => !wrapped(n)), books.filter(wrapped)])
    for (let i = 0; i < part.length; i += cols) rows.push(part.slice(i, i + cols));
  return rows
    .map(
      row =>
        `<div class="bk-shelf-row" role="presentation" data-cols="${cols}" style="--cols:${cols}">${row
          .map(n => shelfBook(n, opts(n)))
          .join('')}</div>`,
    )
    .join('');
}

// A notebook on the Shelf. here: the one the book shows (its ribbon out). menu: its menu open. asking: a round's Close
// asking first, the count of open asks. playing: its envelope moving ('wrap' or 'unwrap').
function shelfBook(n, { here, menu, asking, playing }) {
  const r = n.kind === 'round' ? n.round : null;
  if (r && (r.state === 'away' || r.state === 'back')) return envelopeBook(n, playing);
  const said = lineOf(n),
    asks = asksOf(n),
    pages = `${n.pages} ${n.pages === 1 ? 'page' : 'pages'}`;
  return `<div class="bk-tile bk-book" role="listitem" data-book="${esc(n.id)}" data-kind="${esc(n.kind)}"${
    r ? ` data-state="${r.state}"` : ''
  }${here ? ' aria-current="true"' : ''}><button type="button" class="bk-tile-open" aria-label="${esc(
    `${n.name}, ${said.words}${asks && !asks.open ? `, ${asks.said}` : ''}, ${pages}`,
  )}"><span class="bk-cover">${coverArt(n)}<span class="bk-cover-label"><b class="bk-cover-title">${esc(
    n.name,
  )}</b><span class="bk-cover-line"${said.red ? ' data-red' : ''}>${esc(said.words)}</span></span>${
    asks ? asks.html : ''
  }${here ? '<i class="bk-ribbon"></i>' : ''}</span></button>${bookMenu(n, menu)}${
    asking == null ? '' : roundAsk(asking)
  }</div>`;
}

// The book's own small menu: a quiet button at its frame's corner, its list under it while open
function bookMenu(n, open) {
  const items = [
    ['data-shelf="cover"', 'Change cover'],
    ...(n.round?.state === 'open' ? [['data-round="close"', 'Close the round']] : []),
    // (an open round too: its guests write on in the Archive)
    ...(n.kind === 'mine'
      ? []
      : [[`data-shelf="${n.archived ? 'restore' : 'archive'}"`, n.archived ? 'Back on the Shelf' : 'Archive']]),
  ];
  return `<button type="button" class="bk-book-more" aria-haspopup="menu" aria-expanded="${!!open}" aria-label="${esc(
    `More: ${n.name}`,
  )}">${ICONS.more}</button>${
    open
      ? `<div class="bk-book-menu" role="menu" aria-label="${esc(n.name)}">${items
          .map(([data, words]) => `<button type="button" role="menuitem" ${data}>${words}</button>`)
          .join('')}</div>`
      : ''
  }`;
}

// The one line under a book's name: what waits on the board (red), the answers new since it last read the book, a
// round's guests, or how quiet it is
export function lineOf(n, now = Date.now()) {
  const open = n.asks?.open ?? 0,
    news = n.news ?? 0,
    r = n.kind === 'round' ? n.round : null;
  if (open) return { words: `${plural(open, 'ask waits', 'asks wait')} on you`, red: true };
  if (news) return { words: `${plural(news, 'new answer', 'new answers')}` };
  if (r?.state === 'open') {
    const guests = r.guests ?? [];
    return { words: `${plural(guests.length, 'guest', 'guests')} · ${guests.filter(g => g.done).length} done` };
  }
  if (r?.state === 'done') return { words: 'Advice back' };
  return { words: now - Date.parse(n.updated) > QUIET_MS ? 'quiet this week' : 'all read' };
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The agents' design asks in a notebook, counted on its cover's corner (ink/askpages.ts): red, the ones waiting on the
// board; grey, all of them once none waits; nothing for a notebook with none.
function asksOf(n) {
  const { open = 0, all = 0 } = n.asks ?? {};
  if (!all) return null;
  return {
    open,
    said: open ? `${plural(open, 'ask waits', 'asks wait')} on you` : `${plural(all, 'ask', 'asks')}, all answered`,
    html: `<i class="bk-asks"${open ? ' data-open' : ''} aria-hidden="true">${open || all}</i>`,
  };
}

// ---- covers

// A book's picture, the board's or its project's, pasted on its cover as a print; none, and the cloth is bare but for
// its label, as the notebook's own is
function coverArt(n) {
  return n.cover
    ? `<span class="bk-cover-frame"><img src="${esc(n.cover)}" alt="" draggable="false" decoding="async"></span>`
    : '';
}

// ---- a review round's book away to the CEO, or back

// Its close asked first while asks are open: their count, Close anyway or Not yet
function roundAsk(open) {
  return `<div class="bk-round-ask" role="alertdialog" aria-label="Close the round"><p>${esc(
    `${plural(open, 'ask', 'asks')} still open: close anyway?`,
  )}</p><span><button type="button" data-round="anyway">Close</button><button type="button" data-round="keep">Not yet</button></span></div>`;
}
// The envelope it goes away in: brown paper, its flap over the top, a string wound round two buttons in a figure of
// eight, its end hanging free (the part to pull). Its sheet: the book's cover going in, or coming out.
const ENVELOPE = `<svg class="bk-env-art" viewBox="0 0 100 136" aria-hidden="true"><g fill="none" stroke="#2a2420" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path class="bk-env-flap-in" d="M6 26a4 4 0 0 1 4-4h80a4 4 0 0 1 4 4v20c0 10-8 16-18 16H24C14 62 6 56 6 46z" fill="#b8935e"/><g class="bk-env-sheet"><rect x="16" y="10" width="68" height="84" rx="2" fill="#fbf5e7"/><path d="M28 30h44M28 40h36M28 50h40" stroke-width="1.6"/></g><rect class="bk-env-body" x="6" y="22" width="88" height="108" rx="4" fill="#cfae7f"/><path d="M14 36h20M66 92h20" stroke-width="1" opacity=".45"/><path class="bk-env-flap" d="M6 26a4 4 0 0 1 4-4h80a4 4 0 0 1 4 4v20c0 10-8 16-18 16H24C14 62 6 56 6 46z" fill="#c9a571"/><path d="M10 70h28M62 70h28" stroke-width="1" stroke-dasharray="1.5 3" opacity=".6"/><circle cx="50" cy="52" r="5.4" fill="#fbf5e7"/><circle cx="50" cy="76" r="5.4" fill="#fbf5e7"/><path class="bk-env-string" pathLength="100" d="M50 52c-15-8-15 32 0 24c15-8 15-32 0-24M50 76c3 6-3 9 1 14c2 3 0 5-1 7"/></g><circle class="bk-env-pull" cx="50" cy="90" r="14" fill="transparent"/></svg>`;
// Away: the envelope to the CEO, with what's happening above it; back: the Advice's lime label, its string to pull
function envelopeBook(n, playing) {
  const r = n.round,
    back = r.state === 'back',
    label = back ? `Advice · ${n.name}` : `To ${r.with} · ${n.name}`,
    note = back ? `Back from ${r.with}: pull the string to unwrap` : `${r.with}'s team writes the Advice`;
  return `<div class="bk-tile bk-book bk-round" role="listitem" data-book="${esc(n.id)}" data-kind="round" data-state="${
    n.round.state
  }"${playing ? ` data-playing="${playing}"` : ''}><button type="button" class="bk-tile-open"${
    back ? ' data-round="unwrap"' : ''
  } aria-label="${esc(`${label}. ${note}`)}"><span class="bk-env-note">${esc(note)}</span><span class="bk-envelope">${ENVELOPE}<span class="bk-env-label"${
    back ? ' data-back' : ''
  }>${esc(label)}</span></span></button></div>`;
}
