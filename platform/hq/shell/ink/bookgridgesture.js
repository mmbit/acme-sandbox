// The circle and line on the grid: the grid takes no ink, so a Pencil's stroke there is only this gesture. A loop round
// a scrap's card (one stroke that carries on out of it, or a loop lifted and a line started near it within LINK_MS)
// lifts the card; as the line starts the page's controls fade and the two drop zones slide in (bookdropzones.js):
// People, everyone invited, and Pages, the chapter's. Lifted on a person, the scrap goes to them (it stays here,
// wearing their face); on a page, it moves there (bookmoveto.js, Undo a step); anywhere else nothing happens. The
// circle and line vanish after and the controls come back. A tap is never the gesture's: it opens the scrap or adds
// one in a gap (bookwrite.js). Only the board's: a guest's grid has none.
//
// Everything here is on the screen (client px): the stroke, the cards' boxes, the zones.
import { esc } from '../../util.js';
import { toast } from '../toast.js';
import { scope } from './bookscope.js';
import { shut } from './booksave.js';
import { assignGroup, loadPeople } from './notebookdata.js';
import { boundsOf, inside, membersOf } from './bookselectmath.js';
import { boxOfText } from './bookselect.js';
import { followPress } from './bookpress.js';
import { leftRing, ringAt } from './bookassignmath.js';
import { freshTag } from './bookassignlist.js';
import { cardCopy, fly, tidy } from './bookassignfly.js';
import { openZones } from './bookdropzones.js';

// a ring closes where the stroke comes back this near (px) to a point at least ROUND_PX before it along the stroke;
// the line out of it has left once it's LEAVE_PX clear of the ring
const CLOSE_PX = 28,
  ROUND_PX = 160,
  LEAVE_PX = 36;
// a loop lifted waits this long (ms) for its line, which starts inside it or this near it (px)
const LINK_MS = 1200,
  NEAR_PX = 56;
// a press that moves no further than this (px) is a tap, never the gesture's
const TAP_PX = 6;
// the tag pops in this long (ms) after the copy sets off: as it lands
const TAG_MS = 1200;
const SVG = 'http://www.w3.org/2000/svg';

// sel: bookselect.js's (mountAssign mounts it)
export function mountGridGesture(sel) {
  const g = { sel, book: sel.book, waiting: null };
  addEventListener('pointerdown', e => pressed(g, e), true);
}

// A pen's or a mouse's press on the grid of an open page of the board's, followed
function pressed(g, down) {
  const { book } = g;
  // (a finger pans the grid; the pen draws the gesture, and a mouse can)
  const draws = down.pointerType === 'pen' || (down.pointerType === 'mouse' && down.button === 0);
  if (scope || !draws || !down.isPrimary || book.scrap?.view?.()) return;
  if (!(book.tools?.gestures?.() ?? true)) return;
  if (down.target.closest?.('button, input, textarea, [contenteditable], .bk-card, .bk-island, .bk-zone')) return;
  const hit = book.at(down.clientX, down.clientY),
    page = hit?.view.page;
  if (!page?.groups || page.focus || shut(page)) return;
  const at = [down.clientX, down.clientY],
    waited = g.waiting && near(g.waiting.ring.poly, at) ? g.waiting : null;
  if (g.waiting) {
    clearTimeout(g.waiting.timer);
    if (!waited) tidy([g.waiting.svg, g.waiting.ring.halo]);
    g.waiting = null;
  }
  // (a line after its loop: its ring is the loop's, the line the whole new stroke)
  const s = {
    g,
    view: hit.view,
    path: [at],
    checked: 1,
    svg: null,
    ring: waited?.ring ?? null,
    line: null,
    zones: null,
  };
  s.after = waited;
  followPress(down, {
    move: m => moved(s, m),
    up: u => lifted(s, u),
  });
}

function moved(s, m) {
  const all = m.getCoalescedEvents?.() ?? [];
  for (const c of all.length ? all : [m]) s.path.push([c.clientX, c.clientY]);
  if (!s.svg) {
    if (Math.hypot(m.clientX - s.path[0][0], m.clientY - s.path[0][1]) <= TAP_PX) return;
    s.svg = strokeSvg();
  }
  drawn(s.svg, s.path);
  const end = s.path.at(-1);
  if (!s.ring) s.ring = ringed(s);
  else if (s.line === null && (s.after || leftRing(s.ring.poly, end, LEAVE_PX))) started(s);
  if (s.line !== null) s.zones.light(s.zones.at(m.clientX, m.clientY));
}
// The ring the stroke has closed since last looked, if it holds a scrap's card: { poly, to (where it closed on the
// stroke), gid, card, halo }, or null
function ringed(s) {
  for (; s.checked < s.path.length; s.checked++) {
    const ring = ringAt(s.path, s.checked, CLOSE_PX, ROUND_PX);
    if (!ring) continue;
    const poly = s.path.slice(ring.from, ring.to + 1),
      card = cardIn(s.view, poly);
    if (!card) continue;
    s.g.people = loadPeople(s.g.book.dev, s.view.page.id);
    return { poly, to: ring.to, gid: Number(card.dataset.unit), card, halo: halo(card) };
  }
  return null;
}
// The line has started: the controls fade, the zones slide in
function started(s) {
  const { book } = s.g;
  s.line = s.after ? 0 : s.path.length - 1;
  book.desk.closest('#book')?.setAttribute('data-gesture', '');
  s.zones = openZones(book.desk.getBoundingClientRect(), {
    people: s.g.people ?? loadPeople(book.dev, s.view.page.id),
    pages: book.groups.mates(s.view),
    here: s.view.page,
  });
}
function lifted(s, u) {
  const { g } = s;
  if (!s.svg) return;
  if (s.line !== null) return ended(s, u.type === 'pointercancel' ? null : s.zones.at(u.clientX, u.clientY));
  if (!s.ring) return tidy([s.svg]);
  // (a loop lifted: its line may follow)
  g.waiting = {
    ring: s.ring,
    svg: s.svg,
    timer: setTimeout(() => {
      tidy([s.svg, s.ring.halo]);
      g.waiting = null;
    }, LINK_MS),
  };
}
// The line lifted on a mark (null: anywhere else): the scrap given or moved, a copy flying along the line; the
// controls back, the circle, the line and the zones gone
function ended(s, mark) {
  const { g, ring, zones } = s,
    svgs = [s.svg, s.after?.svg].filter(Boolean);
  g.book.desk.closest('#book')?.removeAttribute('data-gesture');
  const done = () => {
    zones.close();
    tidy([...svgs, ring.halo]);
  };
  const person = mark?.dataset.to && zones.person(mark);
  if (!mark || (!person && !mark.dataset.page)) return done();
  zones.light(mark);
  fly(cardCopy(ring.card, s.view), ring.card.getBoundingClientRect(), mark, s.path.slice(s.line)).finally(done);
  if (person) given(s, person);
  else movedTo(s, zones.page(mark));
}

// The scrap handed to a person: it stays, wearing their face once the store has it
async function given(s, person) {
  const { book } = s.g,
    { page } = s.view,
    { gid } = s.ring;
  freshTag(gid, person.to, performance.now() + TAG_MS);
  try {
    const answer = await assignGroup(book.dev, gid, person.to);
    const had = page.groups.get(gid);
    if (had) had.assigned = answer.group.assigned;
    book.groups.drawn(page);
  } catch (e) {
    toast(esc(e.message));
  }
  s.g.people = null;
}
// The scrap moved to a page (null: a new one), as Select's Move to page… moves it: toasted, Undo a step
function movedTo(s, to) {
  const { sel } = s.g,
    things = membersOf(s.view.page, s.ring.gid),
    box = boundsOf(things, t => boxOfText(sel, t));
  sel.book.groups.moveOnto(s.view, { ...things, box }, to);
}

// ---- on the screen

// The card a ring holds: the one its middle is on, else the one whose middle it circles
function cardIn(view, poly) {
  const cards = [...view.el.querySelectorAll('.bk-unit[data-unit]')],
    xs = poly.map(p => p[0]),
    ys = poly.map(p => p[1]),
    mid = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const on = (c, [x, y]) => {
    const r = c.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  return (
    cards.find(c => on(c, mid)) ??
    cards.find(c => {
      const r = c.getBoundingClientRect();
      return inside(poly, [r.left + r.width / 2, r.top + r.height / 2]);
    }) ??
    null
  );
}
// Whether a point is inside a ring or near it
const near = (poly, p) => inside(poly, p) || poly.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) <= NEAR_PX);

// The stroke drawn over the page as it goes
function strokeSvg() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'bk-gesture-line');
  svg.setAttribute('aria-hidden', 'true');
  svg.append(document.createElementNS(SVG, 'path'));
  (document.getElementById('book') ?? document.body).append(svg);
  return svg;
}
// (drawn once a frame, smoothed through the midpoints of its points)
function drawn(svg, path) {
  if (svg.pending) return;
  svg.pending = requestAnimationFrame(() => {
    svg.pending = 0;
    let d = `M${path[0][0]} ${path[0][1]}`;
    for (let i = 1; i < path.length - 1; i++) {
      const [x, y] = path[i],
        [nx, ny] = path[i + 1];
      d += `Q${x} ${y} ${(x + nx) / 2} ${(y + ny) / 2}`;
    }
    const [lx, ly] = path.at(-1);
    svg.firstChild.setAttribute('d', `${d}L${lx} ${ly}`);
  });
}
// A soft lift round the card circled, over it on the screen
function halo(card) {
  const r = card.getBoundingClientRect(),
    el = document.createElement('div');
  el.className = 'bk-ringed';
  Object.assign(el.style, {
    left: `${r.left - 6}px`,
    top: `${r.top - 6}px`,
    width: `${r.width + 12}px`,
    height: `${r.height + 12}px`,
  });
  (document.getElementById('book') ?? document.body).append(el);
  return el;
}
