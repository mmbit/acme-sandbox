// The people a scrap can be handed to, as the board sees them (bookassign.js): the short list (the people picked most
// recently, each at their whole name, then More…), everyone in a sheet that scrolls with a search over it, and the tags
// a scrap wears for whom it went to (bookgroups.js draws them). A card is placed on the paper whole, and grows to its
// longest name. Its look: bookassign.css.
//
// A person is the store's { to, name, kind } (kind: 'guest' | 'agent').
import { esc } from '../../util.js';
import { scope, word } from './bookscope.js';

// a card stands this far (px) from the paper's edges and from what it's beside
const EDGE_PX = 8,
  BESIDE_PX = 16;
// the short list's top-left corner from the line's end it opens at (px): the line runs in under its heading
const AT_LINE = [-14, -20];
const TICK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.5l3.5 3.5 7.5-8"/></svg>';
const LOOK =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4.5 4.5"/></svg>';

// The short list for people (the store's recent), then More… with the count of everyone: a card in the book, not yet
// placed
export function shortList(people, total) {
  const card = cardOf('bk-assign-short', word('Assign to'));
  card.innerHTML = `<p class="bk-assign-head">${word('Recent')}</p>${people.map(rowHtml).join('')}<button type="button"
    class="bk-person bk-assign-more" role="menuitem" data-more style="--i:${people.length}"><span class="bk-face" aria-hidden="true">
    <i></i><i></i><i></i></span><span class="bk-name">${word('More…')} <small>${word('all {n}', { n: total })}</small>
    </span></button>`;
  return card;
}

// Everyone, A to Z, in a sheet: Share with, Done, a search over them and their rows, which scroll
export function everyoneSheet(people) {
  const card = cardOf('bk-assign-all', word('Share with'));
  card.innerHTML = `<div class="bk-assign-top"><b>${word('Share with')}</b><button type="button" class="bk-assign-done"
    >${word('Done')}</button></div><label class="bk-assign-search">${LOOK}<input type="search" autocomplete="off"
    placeholder="${esc(word('Search {n} people', { n: people.length }))}" aria-label="${esc(word('Search people'))}"
    ></label><div class="bk-assign-rows">${people.map(p => rowHtml(p, 0)).join('')}<p class="bk-assign-none" hidden>${word(
      'Nobody by that name',
    )}</p></div>`;
  const field = card.querySelector('input');
  field.addEventListener('input', () => {
    const want = folded(field.value.trim());
    const rows = [...card.querySelectorAll('.bk-person')];
    for (const row of rows) row.hidden = !folded(row.querySelector('.bk-name').textContent).includes(want);
    card.querySelector('.bk-assign-none').hidden = rows.some(row => !row.hidden);
  });
  return card;
}

// A person's row: their initial in a circle, their whole name, what they are (popping in i-th)
const rowHtml = (p, i) =>
  `<button type="button" class="bk-person" role="menuitem" data-to="${esc(p.to)}" style="--i:${i}"><span
    class="bk-face" aria-hidden="true">${esc(initial(p.name))}</span><span class="bk-name">${esc(p.name)}</span><span
    class="bk-kind">${word(p.kind)}</span></button>`;
function cardOf(kind, label) {
  const card = document.createElement('div');
  card.className = `bk-card bk-assign ${kind}`;
  card.setAttribute('role', 'menu');
  card.setAttribute('aria-label', label);
  // (its touches are its own: never the paper's pan, ink or Select under it)
  for (const type of ['pointerdown', 'touchstart']) card.addEventListener(type, e => e.stopPropagation());
  (document.getElementById('book') ?? document.body).append(card);
  return card;
}
export const initial = name => ([...name.trim()][0] ?? '?').toUpperCase();
// (a search finds Moreno in "moreno" and Eloïse in "eloise")
const folded = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

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
// (whole on the paper, its width capped by it: then its longest names wrap rather than be cut. A card taller than the
// paper, on a phone held sideways, takes the screen's height instead)
function put(card, x, y, room) {
  card.style.maxWidth = `${room.width - 2 * EDGE_PX}px`;
  const w = card.offsetWidth,
    h = card.offsetHeight,
    [top, bottom] = h > room.height - 2 * EDGE_PX ? [0, innerHeight] : [room.top, room.bottom];
  card.style.left = `${Math.round(within(x, w, room.left, room.right))}px`;
  card.style.top = `${Math.round(within(y, h, top, bottom))}px`;
}
const within = (at, size, from, to) => Math.max(from + EDGE_PX, Math.min(at, to - EDGE_PX - size));

// The row under a point on the screen, or null
export const rowAt = (card, x, y) =>
  [...card.querySelectorAll('.bk-person:not([hidden])')].find(row => {
    const r = row.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }) ?? null;
// One row lit (null: none)
export function light(card, row) {
  for (const r of card.querySelectorAll('.bk-person[data-lit]')) delete r.dataset.lit;
  if (row) row.dataset.lit = '';
}

// ---- a scrap's tags

// the tag just given ({ g, to, at }: it pops in at `at`, performance.now()'s ms), whenever its group is drawn
let given = null;
export const freshTag = (g, to, at) => (given = { g, to, at });

// A group's tags, at its unit's bottom-right corner (bookunits.js places them): an initial in a circle for each person
// it went to, with a tick by it once they've answered
export function tagsHtml(g) {
  if (scope || !g.assigned?.length) return '';
  const tags = g.assigned.map(p => {
    const label = p.answered ? word('{name} answered', { name: p.name }) : word('Assigned to {name}', { name: p.name });
    const fresh = popping(g, p) ? ` data-new style="--wait:${Math.round(given.at - performance.now())}ms"` : '';
    return `<span class="bk-tag" title="${esc(label)}" aria-label="${esc(label)}"${fresh}>${p.answered ? TICK : ''}<span
      class="bk-face">${esc(initial(p.name))}</span></span>`;
  });
  return `<div class="bk-tags" data-g="${g.id}">${tags.join('')}</div>`;
}
// (drawn again after it has popped in, it's just there)
const popping = (g, p) => given?.g === g.id && given.to === p.to && performance.now() < given.at;
