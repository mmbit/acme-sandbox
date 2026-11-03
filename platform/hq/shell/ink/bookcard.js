// A list card in the book: a card of rows lying on the paper, placed whole on the screen (at a line's end, beside a
// box or at a point), the row under a point found and lit. The guests to hand a scrap to (bookassignlist.js) and the
// pages to move to (bookmoveto.js pagesCard) are each one. Its look: bookcard.css.
import { stylesheet } from '../../util.js';

stylesheet('shell/ink/bookcard.css');

// a card stands this far (px) from the paper's edges and from what it's beside
const EDGE_PX = 8,
  BESIDE_PX = 16;
// a card's top-left corner from the line's end it opens at (px): the line runs in under its heading
const AT_LINE = [-14, -20];

// A card of a kind, named label, in the book
export function cardOf(kind, label) {
  const card = document.createElement('div');
  card.className = `bk-card bk-list ${kind}`;
  card.setAttribute('role', 'menu');
  card.setAttribute('aria-label', label);
  // (its touches are its own: never the paper's pan, ink or Select under it)
  for (const type of ['pointerdown', 'touchstart']) card.addEventListener(type, e => e.stopPropagation());
  (document.getElementById('book') ?? document.body).append(card);
  return card;
}

// ---- where a card goes
// (room: the paper's part of the screen, a DOMRect: a card stays on it, clear of the book's tabs and HQ around it)

// Its top-left at a line's end ([x, y] on the screen), or left of it where the paper has no room on the right
export function placeAt(card, [x, y], room) {
  const w = card.offsetWidth,
    left = x + AT_LINE[0] + w > room.right - EDGE_PX ? x - AT_LINE[0] - w : x + AT_LINE[0];
  put(card, left, y + AT_LINE[1], room);
}
// Beside a box on the screen (a DOMRect): right of it, else left of it, else over it, its top at the box's top
export function placeBeside(card, box, room) {
  const w = card.offsetWidth,
    right = box.right + BESIDE_PX,
    left = box.left - BESIDE_PX - w;
  const x =
    right + w <= room.right - EDGE_PX ? right : left >= room.left + EDGE_PX ? left : box.left + box.width / 2 - w / 2;
  put(card, x, box.top, room);
}
// Its top-left at x, y on the screen, moved in to lie whole on the paper, its width capped by it: then its longest
// names wrap rather than be cut. A card taller than the paper, on a phone held sideways, takes the screen's height
// instead.
export function put(card, x, y, room) {
  card.style.maxWidth = `${room.width - 2 * EDGE_PX}px`;
  const w = card.offsetWidth,
    h = card.offsetHeight,
    [top, bottom] = h > room.height - 2 * EDGE_PX ? [0, innerHeight] : [room.top, room.bottom];
  card.style.left = `${Math.round(within(x, w, room.left, room.right))}px`;
  card.style.top = `${Math.round(within(y, h, top, bottom))}px`;
}
const within = (at, size, from, to) => Math.max(from + EDGE_PX, Math.min(at, to - EDGE_PX - size));

// The row under a point on the screen that can be picked, or null
export const rowAt = (card, x, y) =>
  [...card.querySelectorAll('.bk-row:not([hidden], [aria-disabled])')].find(row => {
    const r = row.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }) ?? null;
// One row lit (null: none)
export function light(card, row) {
  for (const r of card.querySelectorAll('.bk-row[data-lit]')) delete r.dataset.lit;
  if (row) row.dataset.lit = '';
}
