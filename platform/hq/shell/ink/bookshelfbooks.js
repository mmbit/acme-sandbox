// My shelf as a bookcase (bookshelf.js draws it in its window, bookshelfbooks.css): its boards in rows, each with as many
// things standing on it as fit. A notebook stands covers out: its cloth, a printed plate with its picture (the board's
// or its project's, else a drawing of a pen), its name and one line of news, its open asks counted red on its corner.
// A review round away to the CEO, or back, is its brown envelope standing there instead. The Archive is a lidded box
// on a board with its count; the potted plant stands in the free room on a board of My shelf, never the Archive's.
import { esc, store } from '../../util.js';
import { shelfFit, shelfOrder } from './bookshelfgrid.js';
import { ICONS } from './bookshelftiles.js';

// a book quiet this long reads "quiet this week"
const QUIET_MS = 7 * 864e5;
// the books' cloths: My journal's the book's own black cover (booklook.css --bk-cloth), every other book's one of these
// by its id, the same each time
const JOURNAL_CLOTH = 'var(--bk-cloth)',
  CLOTHS = ['#3f7d78', '#a5523f', '#c2953c', '#6b4f7c', '#4f7550'];

// how many things (books and the Archive's box) stood on My shelf when last read, kept on the device: the boards it
// stands with before it's read
const SHELF_THINGS = 'book.shelfThings';

// My shelf, or its Archive, in the overview s (bookshelf.js mountScreens): one title line (the way back from the
// Archive, its name, the window's Close after it: bookshelfwindow.js), then the bookcase, the plant on My shelf only.
// Not read yet (s.unread while it's drawn so), its boards stand empty, as many as it had last time; once read, its
// things arrive on them. Guests are invited from the work, Share on it (desk.js): no Invite here
export function drawShelf(s) {
  const read = s.read.shelf,
    archive = s.tab === 'archive',
    books = read ? shelfOrder(archive ? read.archive : read.shelf) : [];
  s.head.innerHTML = `${
    archive
      ? `<button type="button" class="bk-far-up" data-tab="shelf" aria-label="Back to My shelf">${ICONS.up}<span>My shelf</span></button>`
      : '<span></span>'
  }<h2 class="bk-shelf-title">${archive ? 'Archive' : 'My shelf'}</h2>`;
  const fit = shelfFit(s.body.clientWidth),
    arriving = read && s.unread;
  s.cols = fit.cols;
  s.unread = !read;
  if (read && !archive) store.set(SHELF_THINGS, books.length + 1);
  const rows = read
    ? shelfRows(
        books,
        { cols: s.cols, box: archive ? null : read.archive.length, plant: archive ? null : fit.plant },
        n => ({ playing: s.playing?.id === n.id ? s.playing.kind : null }),
      )
    : shelfRows([], { cols: s.cols, box: null, plant: null, least: Math.ceil(store.get(SHELF_THINGS, 4) / s.cols) });
  s.body.innerHTML = `<div class="bk-shelf" role="presentation"${
    arriving ? ' data-arriving' : ''
  } style="--bk-book-w:${fit.book}px;--bk-row-in:${fit.inset}px">${rows}</div>${
    archive && read && !books.length
      ? '<p class="bk-far-none">Nothing archived. A notebook archived from its options waits here.</p>'
      : ''
  }`;
}
// The bookcase's boards, each a row of cols, at least `least` of them (the boards a shelf not read yet stands with).
// things: the books, the Archive's box after them (its count; none in the Archive itself); plant: the row it stands at
// the end of ('first' or 'last'; null: none). opts(n): a book's (shelfBook's).
function shelfRows(books, { cols, box, plant, least = 1 }, opts) {
  const wrapped = n => n.kind === 'round' && ['away', 'back'].includes(n.round?.state),
    things = [...books.filter(n => !wrapped(n)), ...books.filter(wrapped)].map(n => shelfBook(n, opts(n)));
  if (box != null) things.push(archiveBox(box));
  const rows = [];
  for (let i = 0; i < things.length; i += cols) rows.push(things.slice(i, i + cols));
  while (rows.length < least) rows.push([]);
  if (plant) rows[plant === 'first' ? 0 : rows.length - 1].push(PLANT);
  return `${rows
    .map(
      row =>
        `<div class="bk-shelf-row" role="presentation" data-cols="${cols}" style="--cols:${cols}">${row.join('')}</div>`,
    )
    .join('')}<div class="bk-shelf-base" role="presentation"></div>`;
}

// A notebook on the Shelf. playing: its envelope moving ('wrap' or 'unwrap').
function shelfBook(n, { playing }) {
  const r = n.kind === 'round' ? n.round : null;
  if (r && (r.state === 'away' || r.state === 'back')) return envelopeBook(n, playing);
  const said = lineOf(n),
    open = n.asks?.open ?? 0,
    asks = n.asks?.all ? `, ${asksSaid(n.asks)}` : '',
    pages = `${n.pages} ${n.pages === 1 ? 'page' : 'pages'}`;
  return `<div class="bk-tile bk-book" role="listitem" data-book="${esc(n.id)}" data-kind="${esc(n.kind)}"${
    r ? ` data-state="${r.state}"` : ''
  } style="--bk-shelf-cloth:${clothOf(n)}"><button type="button" class="bk-tile-open" aria-label="${esc(
    `${n.name}, ${said.words}${asks}, ${pages}`,
  )}"><span class="bk-cover"><span class="bk-cover-plate">${coverArt(n)}<span class="bk-cover-title">${esc(
    n.name,
  )}</span><span class="bk-cover-line"${said.red ? ' data-red' : ''}>${esc(said.words)}</span></span>${
    open ? `<i class="bk-asks" aria-hidden="true">${open}</i>` : ''
  }</span></button></div>`;
}
const clothOf = n => (n.kind === 'mine' ? JOURNAL_CLOTH : CLOTHS[n.id % CLOTHS.length]);

// The one line under a book's name: what waits on the board (red), the answers new since it last read the book, a
// round's guests, or how quiet it is
export function lineOf(n, now = Date.now()) {
  const open = n.asks?.open ?? 0,
    news = n.news ?? 0,
    r = n.kind === 'round' ? n.round : null;
  if (open) return { words: plural(open, 'ask waits', 'asks wait'), red: true };
  if (news) return { words: `${plural(news, 'new answer', 'new answers')}` };
  if (r?.state === 'open') {
    const guests = r.guests ?? [];
    return { words: `${plural(guests.length, 'guest', 'guests')} · ${guests.filter(g => g.done).length} done` };
  }
  if (r?.state === 'done') return { words: 'Advice back' };
  return { words: now - Date.parse(n.updated) > QUIET_MS ? 'quiet this week' : 'all read' };
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// The agents' design asks in a notebook (ink/askpages.ts) said: those waiting on the board, or all answered
const asksSaid = ({ open = 0, all = 0 }) =>
  open ? `${plural(open, 'ask waits', 'asks wait')} on you` : `${plural(all, 'ask', 'asks')}, all answered`;

// ---- covers

// A book's picture printed on its plate: the board's or its project's, else a pen drawing a line, in the book's ink
// with the one chosen-colour accent
const PEN = `<svg class="bk-cover-art" viewBox="0 0 120 110" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M30 84l8-22 44-44 14 14-44 44z" fill="var(--bk-plate)"/><path d="M74 26l14 14"/><path d="M24 98c14-6 24 4 38-2s22 2 34-4" stroke-width="1.6"/><path d="M30 84l8-22 14 14z" fill="var(--bk-chosen)"/></g></svg>`;
const coverArt = n =>
  n.cover ? `<img class="bk-cover-art" src="${esc(n.cover)}" alt="" draggable="false" decoding="async">` : PEN;

// ---- the Archive's box and the plant

// A lidded archive box, its label written on: the notebooks put away
const archiveBox = count =>
  `<div class="bk-shelf-thing" role="listitem"><button type="button" class="bk-shelf-box" data-tab="archive" aria-label="The Archive: ${plural(
    count,
    'book',
    'books',
  )}"><i class="bk-box-lid"></i><span class="bk-box-label">Archive <small>· ${count}</small></span><i class="bk-box-grip"></i></button></div>`;

// A snake plant in a clay pot, lit as the books are, from the upper left: each leaf rounded by its light and shade,
// its pale edge and banding; the pot a cylinder, its rim catching the light, the soil dark inside; its shadow on the
// back and the board (bookshelfbooks.css)
const LEAVES = [
  // [foot x, lean, height, width, behind]
  [24, -18, 74, 11, true],
  [40, 16, 66, 11, true],
  [19, -26, 50, 10, false],
  [44, 24, 46, 10, false],
  [29, -5, 100, 13, false],
  [36, 7, 88, 12, false],
];
function leaf([fx, lean, h, w, behind]) {
  const top = 68 - h,
    tx = fx + lean,
    d = `M${fx - w / 2} 70C${fx - w / 2 - 2} ${68 - h * 0.45} ${tx - w * 0.7} ${top + h * 0.3} ${tx} ${top}C${tx + w * 0.7} ${
      top + h * 0.3
    } ${fx + w / 2 + 2} ${68 - h * 0.45} ${fx + w / 2} 70z`;
  return `<path d="${d}" fill="url(#bk-leaf${behind ? '-back' : ''})" stroke="#c4cf7e" stroke-width=".9"/>
    <path d="${d}" fill="url(#bk-leaf-bands)" opacity=".55"/>
    <path d="M${fx - 1} 68Q${fx + lean * 0.4} ${68 - h * 0.5} ${tx} ${top + 6}" fill="none" stroke="rgba(235,245,215,.5)" stroke-width="1.4" stroke-linecap="round"/>`;
}
const PLANT = `<div class="bk-shelf-thing bk-shelf-potted" role="presentation"><svg class="bk-shelf-plant" viewBox="0 0 64 120" aria-hidden="true">
  <defs>
    <linearGradient id="bk-leaf" x1="0" x2="1"><stop offset="0" stop-color="#4d7a3e"/><stop offset=".42" stop-color="#86ae66"/><stop offset=".58" stop-color="#9cc07a"/><stop offset="1" stop-color="#456f37"/></linearGradient>
    <linearGradient id="bk-leaf-back" x1="0" x2="1"><stop offset="0" stop-color="#3c6331"/><stop offset=".5" stop-color="#6b9452"/><stop offset="1" stop-color="#365a2c"/></linearGradient>
    <pattern id="bk-leaf-bands" width="64" height="9" patternUnits="userSpaceOnUse"><path d="M0 2.5q16 2.5 32 0t32 0" fill="none" stroke="#2f4f26" stroke-width="1.6" opacity=".45"/></pattern>
    <linearGradient id="bk-pot" x1="0" x2="1"><stop offset="0" stop-color="#a9552f"/><stop offset=".3" stop-color="#e29262"/><stop offset=".55" stop-color="#cf7a4c"/><stop offset="1" stop-color="#8f4426"/></linearGradient>
    <linearGradient id="bk-rim" x1="0" x2="1"><stop offset="0" stop-color="#b9643a"/><stop offset=".3" stop-color="#f0a676"/><stop offset=".6" stop-color="#d9865a"/><stop offset="1" stop-color="#9c4c2b"/></linearGradient>
    <linearGradient id="bk-under-rim" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#5a2410" stop-opacity=".45"/><stop offset="1" stop-color="#5a2410" stop-opacity="0"/></linearGradient>
  </defs>
  <ellipse cx="32" cy="70" rx="19" ry="3.4" fill="#4a2f1d"/>
  ${LEAVES.map(leaf).join('')}
  <path d="M14 76h36l-4.2 42.5a2 2 0 0 1-2 1.5H20.2a2 2 0 0 1-2-1.5z" fill="url(#bk-pot)"/>
  <path d="M14 76h36l-.5 6H14.5z" fill="url(#bk-under-rim)"/>
  <rect x="11" y="67" width="42" height="10" rx="2" fill="url(#bk-rim)"/>
  <path d="M12.5 67.8h39" stroke="rgba(255,226,196,.75)" stroke-width="1" stroke-linecap="round"/>
</svg></div>`;

// ---- a review round's book away to the CEO, or back

// The envelope it goes away in: brown paper, its flap over the top, a string wound round two buttons in a figure of
// eight, its end hanging free (the part to pull). Its sheet: the book's cover going in, or coming out.
const ENVELOPE = `<svg class="bk-env-art" viewBox="0 0 100 136" aria-hidden="true"><g fill="none" stroke="#2a2420" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path class="bk-env-flap-in" d="M6 26a4 4 0 0 1 4-4h80a4 4 0 0 1 4 4v20c0 10-8 16-18 16H24C14 62 6 56 6 46z" fill="#b8935e"/><g class="bk-env-sheet"><rect x="16" y="10" width="68" height="84" rx="2" fill="#fbf5e7"/><path d="M28 30h44M28 40h36M28 50h40" stroke-width="1.6"/></g><rect class="bk-env-body" x="6" y="22" width="88" height="108" rx="4" fill="#cfae7f"/><path d="M14 36h20M66 92h20" stroke-width="1" opacity=".45"/><path class="bk-env-flap" d="M6 26a4 4 0 0 1 4-4h80a4 4 0 0 1 4 4v20c0 10-8 16-18 16H24C14 62 6 56 6 46z" fill="#c9a571"/><path d="M10 70h28M62 70h28" stroke-width="1" stroke-dasharray="1.5 3" opacity=".6"/><circle cx="50" cy="52" r="5.4" fill="#fbf5e7"/><circle cx="50" cy="76" r="5.4" fill="#fbf5e7"/><path class="bk-env-string" pathLength="100" d="M50 52c-15-8-15 32 0 24c15-8 15-32 0-24M50 76c3 6-3 9 1 14c2 3 0 5-1 7"/></g><circle class="bk-env-pull" cx="50" cy="90" r="14" fill="transparent"/></svg>`;
// Away: the envelope to the CEO, with what's happening above it; back: the Advice's label in the chosen colour, its
// string to pull
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
