// What's still the board's to answer on the page shown: a group carrying an open ask (an agent's card, bookasks.js)
// wears a red edge marked "for you", and a small counter by the page's title says how many are open ("2 open"), its
// arrows sliding the page to each in turn, the one reached pulsing once. With none open it's away: nothing waits
// on the board (the board's own drawings brought it up as soon as a page had any). In a guest's book, the board's scraps handed to them wait the same way till they write on one (forYou). Its
// look: bookforyou.css. (by the page's title, as the Ink deck draws it.)
import { stylesheet } from '../../util.js';
import { button } from './bookui.js';
import { icon } from '../icons.js';
import { word } from './bookscope.js';
import { boxesOf, bringIntoSight, reachOf } from './bookgroupshow.js';
import { boxRound } from './notebookstack.js';

// book: bookpages.js's: the counter in its paper's head, at its right, kept where it is as the page pans and
// zooms under it. Returns { update(far) }: the counter as the page shown is now (far: the overview open, where it's
// away).
export function mountForYou(book) {
  stylesheet('shell/ink/bookforyou.css');
  const el = document.createElement('div'),
    st = { book, el, page: null, at: null };
  el.className = 'bk-for-you-count';
  el.setAttribute('role', 'group');
  el.setAttribute('data-keep-clear', ''); // (a minimised call keeps clear of it.)
  el.setAttribute('data-no-ink', '');
  el.hidden = true;
  el.innerHTML = '<span class="bk-open" aria-live="polite"></span>';
  st.before = button({ icon: icon('up'), onClick: () => step(st, -1) });
  st.next = button({ icon: icon('down'), onClick: () => step(st, 1) });
  el.append(st.before, st.next);
  book.paper.querySelector('.bk-pages').append(el);
  return { update: far => update(st, far) };
}

// A page's layer of groups just drawn (bookgroups.js): a red edge round each group with an open ask, its answers and
// cards under it inside it too
export function markOpen(view, layer) {
  const edges = openOn(view.page)
    .map(g => [g.id, boxesOf(view, g.id)])
    .filter(([, parts]) => parts.length)
    .map(([id, parts]) => edge(id, parts));
  layer.insertAdjacentHTML('afterbegin', edges.join(''));
}
// A group's edge (page px): its box round the unit and its cards, the line drawn a little off each of them, one line
// where they meet and two where they don't, so it never takes in what lies between them (beside its note on a sketch
// page, the next note's headline). Its tag at the unit's top right. The line and its glow are a picture of their own
// (a data: URL, its mask inside it) masking the book's red, so a copy of the page (a turn's, a crumple's) draws it
// too, with no id to find in the document.
function edge(id, parts) {
  const r = boxRound(parts),
    [unit] = parts,
    w = r.w + 2 * GLOW_PX,
    h = r.h + 2 * GLOW_PX;
  // (each part grown by out page px, its corners rounded to match: shown white, hidden black, in the picture's mask)
  const grown = (out, fill) =>
    parts
      .map(
        b =>
          `<rect x="${b.x - r.x - out}" y="${b.y - r.y - out}" width="${b.w + 2 * out}" height="${b.h + 2 * out}" ` +
          `rx="${RADIUS_PX + out - EDGE_PX}" fill="${fill}"/>`,
      )
      .join('');
  const line =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-GLOW_PX} ${-GLOW_PX} ${w} ${h}" width="${w}" height="${h}">` +
    `<mask id="m"><g opacity="0.18">${grown(GLOW_PX, '#fff')}</g>${grown(EDGE_PX, '#fff')}` +
    `${grown(EDGE_PX - LINE_PX, '#000')}</mask>` +
    `<rect x="${-GLOW_PX}" y="${-GLOW_PX}" width="${w}" height="${h}" mask="url(#m)"/></svg>`;
  const tag = `--tag-top:${unit.y - r.y}px;--tag-right:${r.x + r.w - unit.x - unit.w}px`;
  return (
    `<div class="bk-for-you" data-g="${id}" style="${boxStyle(r)}" aria-hidden="true">` +
    `<i style="left:${-GLOW_PX}px;top:${-GLOW_PX}px;width:${w}px;height:${h}px;` +
    `--bk-edge:url('data:image/svg+xml,${encodeURIComponent(line)}')"></i>` +
    `<b style="${tag}">for you</b></div>`
  );
}
// (the edge's line, its outer side EDGE_PX off what it rings, RADIUS_PX its corners; its glow out to GLOW_PX. The
// pulse's ring sits on the same line: bookforyou.css .bk-reached)
const EDGE_PX = 10,
  LINE_PX = 2,
  RADIUS_PX = 8,
  GLOW_PX = 14;

function update(st, far) {
  const view = st.book.views[st.book.cur],
    page = view?.page;
  if (page !== st.page) {
    Object.assign(st, { page, at: null });
    delete st.el.dataset.at;
  }
  const open = openOn(page).length;
  st.el.hidden = far || !open;
  if (st.el.hidden) return;
  st.el.dataset.open = open;
  st.el.querySelector('.bk-open').textContent = word('openCount', { n: open });
  st.el.setAttribute('aria-label', `${open} open for you to answer`);
  st.before.setAttribute('aria-label', 'The open ask before');
  st.next.setAttribute('aria-label', 'The next open ask');
}

// The arrows: the page slid to the next open ask (dir 1) or the one before (-1), from the last reached, round to the
// first after the last
function step(st, dir) {
  const view = st.book.views[st.book.cur];
  if (!view?.page.groups) return;
  const steps = stepsOn(view),
    after = steps.filter(s => st.at && dir * compare(s.r, st.at.r) > 0),
    to = (dir > 0 ? after[0] : after.at(-1)) ?? (dir > 0 ? steps[0] : steps.at(-1));
  if (!to) return;
  st.at = to;
  st.el.dataset.at = to.id;
  bringIntoSight(view, to.id, () => pulse(view, to));
}
// The groups the arrows step through, top to bottom: the open asks
function stepsOn(view) {
  return openOn(view.page)
    .map(g => ({ id: g.id, r: reachOf(view, g.id) }))
    .filter(s => s.r)
    .sort((a, b) => compare(a.r, b.r));
}
const compare = (a, b) => a.y - b.y || a.x - b.x;
const openOn = page =>
  [...(page?.groups?.values() ?? [])].filter(g => g.forYou || g.asks?.some(a => a.status === 'open'));

// The group reached ringed once, red, its unit and its cards each: it waits on the board
function pulse(view, to) {
  const layer = view.el.querySelector(':scope > .bk-groups');
  layer?.querySelectorAll(':scope > .bk-reached').forEach(el => el.remove());
  const rings = boxesOf(view, to.id).map(
    b => `<div class="bk-reached" data-g="${to.id}" data-open style="${boxStyle(b)}" aria-hidden="true"></div>`,
  );
  layer?.insertAdjacentHTML('afterbegin', rings.join(''));
}
const boxStyle = r => `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
