// The projects view's levels and the moves between them: where the board is (home, a business, a project, a thread or a
// group) and the keys beside it, the change one level up or to the next key beside, a sideways drag that brings that
// one in, and the motion of each. projects.js keeps the view and paints it. work: the board's businesses and projects,
// and the done threads it has opened.

import { sfx } from './audio.js';
import { dropKey } from './drop.js';
import { inEtaOrder } from './threads.js';

const SWIPE = 70; // how far a sideways drag on a level goes before the next one beside it comes in (CSS px)

// The level the board is at, and the keys beside it (a swipe's)
export function level(view, work) {
  const p = work.projects.find(x => x.id === view.project),
    t = p && threadIn(p, view.thread, work);
  // (a done thread has no keys beside it: the open ones are its project's, in the order its page lists them)
  if (t)
    return {
      at: 'thread',
      p,
      t,
      beside: p.threads.includes(t) ? inEtaOrder(p).map(x => x.id) : [],
      key: 'thread',
      on: t.id,
    };
  if (p) return { at: 'project', p, beside: siblingsOf(p, work).map(x => x.id), key: 'project', on: p.id };
  const b = work.businesses.find(x => x.id === view.business);
  if (b) return { at: 'business', b, beside: work.businesses.map(x => x.id), key: 'business', on: b.id };
  if (view.group) return { at: 'group', beside: [] };
  return { at: 'home', beside: [] };
}
// A project's thread: an open one, or a done one of its own the board opened (its jobs loaded on the tap)
function threadIn(p, id, work) {
  const done = work.closed.get(id);
  return p.threads.find(x => x.id === id) ?? (done?.project === p.id ? done : undefined);
}
export const projectsOf = (business, work) => work.projects.filter(p => p.business === business);
// a project's neighbours: its business's projects, a routine's the other routines (each with its schedule), or every other project where the company has no businesses
const siblingsOf = (p, work) =>
  p.business && work.businesses.length
    ? projectsOf(p.business, work)
    : work.projects.filter(x => !x.schedule === !p.schedule);

// ---------------------------------------------------------------- the changes
// Into a business: at its projects' tiles, even when it has only the one
export const intoBusiness = id => ({ business: id, project: null, thread: null });
// One level up: a thread to its project, a project to its business, a routine's to Recurring, a business or a group
// home. Null at home.
export function upFrom(l, work) {
  if (l.at === 'home') return null;
  if (l.at === 'thread') return { thread: null, showDone: work.closed.has(l.t.id) };
  if (l.at === 'project' && l.p.schedule) return { project: null, business: null, group: 'recurring' };
  if (l.at === 'project' && work.businesses.some(b => b.id === l.p.business))
    return { business: l.p.business, project: null };
  return { business: null, project: null, thread: null, group: null };
}
// The next key beside the level's, round (by: 1 or -1), or null where it has none
export function besideOf(l, by) {
  if (l.beside.length < 2) return null;
  const i = l.beside.indexOf(l.on),
    id = l.beside[(i + by + l.beside.length) % l.beside.length];
  const change =
    l.key === 'business' ? intoBusiness(id) : l.key === 'project' ? { project: id, thread: null } : { thread: id };
  return { ...change, showDone: false };
}

// ---------------------------------------------------------------- the motion
// motion: 'down' a level (its keys drop in), 'up' one, 'from-right'/'from-left' beside it, '' on a refresh (where
// everything was scrolled to stays)
// The level's keys fade out the way it goes (projects.js's go commits a move after this, unless a later one came)
export async function leave(grid, motion) {
  if (!motion || !grid || still()) return;
  const out =
    motion === 'down'
      ? 'scale(.97)'
      : motion === 'up'
        ? 'scale(1.02)'
        : `translateX(${motion === 'from-right' ? -40 : 40}px)`;
  await grid
    .animate([{ opacity: 1 }, { opacity: 0, transform: out }], { duration: 140, easing: 'ease-in', fill: 'forwards' })
    .finished.catch(() => {
      // Cancellation only stops the exit effect. The next level is still painted.
    });
}
// The level's keys come in: down, those in view drop in one after another from above the head and land with a clack,
// as the home page's keys do; up, they settle from a little bigger; beside, from the side of the swipe. Where the board
// is, in the head, comes the way it went.
export function moveIn(el, motion) {
  if (!motion || still()) return;
  const board = el.querySelector('.pj-board').getBoundingClientRect(),
    keys = [...el.querySelectorAll('.pj-level :is(.pj-tile, .pj-task), .pj-level > .pj-none')].filter(
      k => k.getBoundingClientRect().top < board.bottom,
    ),
    told = [...el.querySelectorAll('.pj-head > :not(.pj-key, .pj-slot)')];
  const side = motion === 'up' || motion === 'from-left' ? -1 : 1;
  for (const k of told)
    k.animate(
      [
        { opacity: 0, transform: `translateX(${side * 28}px)` },
        { opacity: 1, transform: 'none' },
      ],
      {
        duration: 320,
        easing: 'cubic-bezier(.2, .9, .3, 1.12)',
        fill: 'backwards',
      },
    );
  if (motion === 'down')
    return keys.forEach((k, i) =>
      dropKey(k, {
        height: k.getBoundingClientRect().bottom - board.top + 24,
        delay: 40 + Math.min(i, 12) * 55,
        tilt: (Math.random() - 0.5) * 8,
        land: hit => i < 8 && sfx.clack(hit ? 0.3 : 0.8, (i * 5) % 12),
      }),
    );
  const from =
    motion === 'up'
      ? { opacity: 0, transform: 'scale(1.04)' }
      : { opacity: 0, transform: `translateX(${side * 50}px)` };
  keys.forEach((k, i) =>
    k.animate([from, { opacity: 1, transform: 'none' }], {
      duration: 300,
      delay: Math.min(i, 12) * 18,
      easing: 'cubic-bezier(.2, .9, .3, 1.12)',
      fill: 'backwards',
    }),
  );
}
// A big card (the view's frame, an open job) flies out of from, the element it opened from or that one's place (a
// DOMRect), and back into it, as Wire's big key does; without one it rises into its place and sinks away. Resolves
// once it's there.
export function fly(el, from, back = false) {
  if (still()) return Promise.resolve();
  const place = from instanceof Element ? (from.isConnected ? from.getBoundingClientRect() : null) : from;
  const there = place?.width ? flight(el, place) : null;
  const frames = back
    ? [
        { transform: 'none' },
        { opacity: 0.2, offset: 0.6 },
        { transform: there ?? 'translateY(14px) scale(.96)', opacity: 0 },
      ]
    : [
        { transform: there ?? 'translateY(26px) scale(.94)', opacity: there ? 0.6 : 0 },
        { transform: 'none', opacity: 1 },
      ];
  return el
    .animate(frames, {
      duration: back ? 240 : 420,
      easing: back ? 'cubic-bezier(.5, 0, .75, .4)' : 'cubic-bezier(.2, .9, .3, 1.08)',
    })
    .finished.catch(() => {
      // A cancelled flight leaves the card where its styles put it.
    });
}
// a place (a DOMRect) as a transform of el: its centre on the place's, scaled to its width
function flight(el, a) {
  const b = el.getBoundingClientRect();
  const dx = a.left + a.width / 2 - b.left - b.width / 2,
    dy = a.top + a.height / 2 - b.top - b.height / 2;
  return `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${(a.width / b.width).toFixed(3)})`;
}
// A card turned over: edge on, then its other face (the flipped class) comes round, its keys hidden while it turns,
// as Wire's big key does. Flat at rest, so a long face still scrolls.
export function turn(card) {
  const faces = card.querySelector('.pj-card-faces');
  if (still() || !faces) return card.classList.toggle('flipped');
  if (card.turning) return;
  card.turning = true;
  for (const k of card.querySelectorAll(':scope > .pj-card-keys'))
    k.animate([{ opacity: 1 }, { opacity: 0, offset: 0.2 }, { opacity: 0, offset: 0.7 }, { opacity: 1 }], 520);
  faces.animate(
    [{ transform: 'perspective(1400px) rotateY(0)' }, { transform: 'perspective(1400px) rotateY(90deg)' }],
    {
      duration: 170,
      easing: 'ease-in',
    },
  ).onfinish = () => {
    card.classList.toggle('flipped');
    faces.animate([{ transform: 'perspective(1400px) rotateY(-90deg)' }, { transform: 'none' }], {
      duration: 320,
      easing: 'cubic-bezier(.3, 1.25, .45, 1)',
    }).onfinish = () => (card.turning = false);
  };
}
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// A sideways drag on el carries the level's keys, and past SWIPE the next one beside it comes in (onSwipe(by), by 1 or
// -1); up and down it scrolls. mayDrag(e): whether a drag at that pointer event carries the level, asked as it starts
// and as it goes (a key lifted to sort ends it). The click that ends a drag isn't a tap: it stops before el's own
// click listeners.
export function swipes(el, { mayDrag, onSwipe }) {
  let drag = null,
    swiped = false;
  el.addEventListener(
    'click',
    e => {
      if (swiped) e.stopImmediatePropagation();
      swiped = false;
    },
    { capture: true },
  );
  el.addEventListener('pointerdown', e => {
    swiped = false;
    const grid = e.target.closest('.pj-level');
    if (grid && mayDrag(e)) drag = { grid, x: e.clientX, y: e.clientY, dx: 0 };
  });
  el.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!mayDrag(e)) {
      drag.grid.style.transform = '';
      drag = null;
      return;
    }
    drag.dx = e.clientX - drag.x;
    if (Math.abs(drag.dx) > 8 && Math.abs(drag.dx) > Math.abs(e.clientY - drag.y))
      Object.assign(drag.grid.style, { transition: 'none', transform: `translateX(${drag.dx}px)` });
  });
  const lift = () => {
    if (!drag) return;
    const { grid, dx } = drag;
    drag = null;
    // (the click that ends it, in the same task, isn't a tap)
    if (Math.abs(dx) > 8 && grid.style.transform) {
      swiped = true;
      setTimeout(() => (swiped = false));
    }
    if (Math.abs(dx) > SWIPE && grid.style.transform) onSwipe(-Math.sign(dx));
    else Object.assign(grid.style, { transition: 'transform .2s', transform: '' });
  };
  el.addEventListener('pointerup', lift);
  el.addEventListener('pointercancel', lift);
}
