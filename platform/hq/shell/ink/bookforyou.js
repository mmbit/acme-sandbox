// What's still the board's to answer on the page shown: a group carrying an open ask (an agent's card, bookasks.js)
// wears a red edge marked "for you", and a small counter on the rail over the page's arrows says how many are open,
// its arrows sliding the page to each in turn, the one reached pulsing once. With none open it's away: nothing waits
// on the board (the board's own drawings brought it up as soon as a page had any). In a guest's book, the board's scraps handed to them wait the same way till they write on one (forYou). Its
// look: bookforyou.css. (a guest's)
import { stylesheet } from '../../util.js';
import { button, lineIcon } from './bookui.js';
import { bringIntoSight, reachOf } from './bookgroupshow.js';

const ICONS = {
  before: lineIcon('<path d="M6 15l6-6 6 6"/>'),
  next: lineIcon('<path d="M6 9l6 6 6-6"/>'),
};

// book: bookpages.js's; foot: the page's controls on the rail (bookui.js island('pages')), the counter at their head.
// Returns { update(far) }: the counter as the page shown is now (far: the overview open, where it's away).
export function mountForYou(book, foot) {
  stylesheet('shell/ink/bookforyou.css');
  const el = document.createElement('div'),
    st = { book, el, page: null, at: null };
  el.className = 'bk-for-you-count';
  el.setAttribute('role', 'group');
  el.hidden = true;
  el.innerHTML = '<span class="bk-open" aria-live="polite"></span>';
  st.before = button({ icon: ICONS.before, onClick: () => step(st, -1) });
  st.next = button({ icon: ICONS.next, onClick: () => step(st, 1) });
  el.append(st.before, st.next);
  foot.prepend(el);
  return { update: far => update(st, far) };
}

// A page's layer of groups just drawn (bookgroups.js): a red edge round each group with an open ask, its answers and
// cards under it inside it too
export function markOpen(view, layer) {
  const edges = openOn(view.page)
    .map(g => [g.id, reachOf(view, g.id)])
    .filter(([, r]) => r)
    .map(
      ([id, r]) =>
        `<div class="bk-for-you" data-g="${id}" style="${boxStyle(r)}" aria-hidden="true"><b>for you</b></div>`,
    );
  layer.insertAdjacentHTML('afterbegin', edges.join(''));
}

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
  st.el.querySelector('.bk-open').textContent = `${open} open`;
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

// The group reached ringed once, red: it waits on the board
function pulse(view, to) {
  const layer = view.el.querySelector(':scope > .bk-groups');
  layer?.querySelector(':scope > .bk-reached')?.remove();
  layer?.insertAdjacentHTML(
    'afterbegin',
    `<div class="bk-reached" data-g="${to.id}" data-open style="${boxStyle(to.r)}" aria-hidden="true"></div>`,
  );
}
const boxStyle = r => `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
