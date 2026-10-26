// The projects view's levels and the moves between them: where the board is (home, a business, a project, a thread or a
// group), the change one level up, and the motion of each. projects.js keeps the view and paints it. work: the board's
// businesses and projects (open, and completed: those whose threads are all done), and the done threads it has opened.

import { sfx } from './audio.js';
import { dropKey, pinKey } from './drop.js'; // (pinKey)
import { finished } from './threads.js';
import { LISTS } from './threadlist.js';

// Where the board starts: home, nothing open (projects.js view)
export const HOME = { business: null, project: null, thread: null, group: null, jobId: null, showDone: false };

// The level the board is at. A thread opened from a list of threads names it (list).
export function level(view, work) {
  const p = [...work.projects, ...work.completed].find(x => x.id === view.project),
    t = p && threadIn(p, view.thread, work);
  if (t) return { at: 'thread', p, t, list: LISTS[view.group] ? view.group : null };
  if (p) return { at: 'project', p };
  const b = work.businesses.find(x => x.id === view.business);
  if (b) return { at: 'business', b };
  if (view.group) return { at: 'group' };
  return { at: 'home' };
}
// A project's thread: an open one, or a done one of its own the board opened (its jobs loaded on the tap)
function threadIn(p, id, work) {
  const done = work.closed.get(id);
  return p.threads.find(x => x.id === id) ?? (done?.project === p.id ? done : undefined);
}
export const projectsOf = (business, work) => work.projects.filter(p => p.business === business);

// ---------------------------------------------------------------- the changes
// Into a business: at its projects' tiles, even when it has only the one
export const intoBusiness = id => ({ business: id, project: null, thread: null });
// One level up: a thread to its project or the list it was opened from, a project to its business, a routine's to
// Recurring, a business or a group home. Null at home.
export function upFrom(l, work) {
  if (l.at === 'home') return null;
  if (l.at === 'thread' && l.list) return { project: null, thread: null, showDone: false };
  if (l.at === 'thread') return { thread: null, showDone: work.closed.has(l.t.id) };
  if (l.at === 'project' && l.p.schedule) return { project: null, business: null, group: 'recurring' };
  if (l.at === 'project' && work.businesses.some(b => b.id === l.p.business))
    return { business: l.p.business, project: null };
  return { business: null, project: null, thread: null, group: null };
}

// ---------------------------------------------------------------- the motion
// motion: 'down' a level (its keys drop in), 'up' one, '' on a refresh (where everything was scrolled to stays)
// The level's keys fade out the way it goes (projects.js's go commits a move after this, unless a later one came)
export async function leave(grid, motion) {
  if (!motion || !grid || still()) return;
  const out = motion === 'down' ? 'scale(.97)' : 'scale(1.02)';
  await grid
    .animate([{ opacity: 1 }, { opacity: 0, transform: out }], { duration: 140, easing: 'ease-in', fill: 'forwards' })
    .finished.catch(() => {
      // Cancellation only stops the exit effect. The next level is still painted.
    });
}
// The level's keys come in: down, those in view drop in one after another from above the head and land with a clack,
// as the home page's keys do (or are pinned on, in a look whose --pj-arrival is pin), and a thread's task rows, which
// aren't tiles, fade in with their tree's lines; up, they settle from a little bigger. Where the board is, in the head,
// comes the way it went.
export function moveIn(el, motion) {
  if (!motion || still()) return;
  const board = el.querySelector('.pj-board').getBoundingClientRect(),
    inView = k => k.getBoundingClientRect().top < board.bottom,
    keys = [...el.querySelectorAll('.pj-level .pj-tile, .pj-level:not(.pj-tasks) > .pj-none')].filter(inView),
    rows = [...el.querySelectorAll('.pj-tasks > li')].filter(inView),
    told = [...el.querySelectorAll('.pj-head :is(.pj-where, .pj-marks, .pj-keys)')];
  const side = motion === 'up' ? -1 : 1;
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
  if (motion === 'down') {
    comeIn(rows, { opacity: 0 }, { duration: 260, stagger: 30, easing: 'ease-out' });
    const arrive = getComputedStyle(el).getPropertyValue('--pj-arrival').trim() === 'pin' ? pinKey : dropKey;
    return keys.forEach((k, i) =>
      arrive(k, {
        height: k.getBoundingClientRect().bottom - board.top + 24,
        delay: 40 + Math.min(i, 12) * 55,
        tilt: (Math.random() - 0.5) * 8,
        land: hit => i < 8 && sfx.clack(hit ? 0.3 : 0.8, (i * 5) % 12),
      }),
    );
  }
  comeIn(
    [...keys, ...rows],
    { opacity: 0, transform: 'scale(1.04)' },
    { duration: 300, stagger: 18, easing: 'cubic-bezier(.2, .9, .3, 1.12)' },
  );
}
// Elements in from a frame of their own, one after another
const comeIn = (els, from, { duration, stagger, easing }) =>
  els.forEach((k, i) =>
    k.animate([from, { opacity: 1, transform: 'none' }], {
      duration,
      delay: Math.min(i, 12) * stagger,
      easing,
      fill: 'backwards',
    }),
  );
// Where a job of the board's lives (j: one with its project and thread, as projects.js reads them): there, with the
// finished tasks showing where it's one, a done thread's or finished itself; null for none.
export function placeOf(j) {
  if (!j?.projectThread) return null;
  const done = !j.project.threads.includes(j.projectThread) || finished(j);
  return { business: null, group: null, project: j.project.id, thread: j.projectThread.id, showDone: done };
}
// A place view names, as a key (projects.js keeps each level's scroll by it)
export const placeKey = v => [v.group, v.business, v.project, v.thread].join('/');
// Whether work holds the place view names (its thread, project or business): a done thread not loaded yet, say, doesn't.
export function holds(view, work) {
  const at = level(view, work).at;
  return view.thread ? at === 'thread' : view.project ? at === 'project' : view.business ? at === 'business' : true;
}
// The element in focus under el, found again after a paint by what it does: one of the keys `names` marks by its value,
// a thread's time or a job's steps
export function focusOf(el, names) {
  const focused = el.contains(document.activeElement) ? document.activeElement : null;
  const name = focused && names.find(n => focused.hasAttribute(n));
  const selector = name
    ? `[${name}="${CSS.escape(focused.getAttribute(name))}"]`
    : focused?.matches('.pj-eta > summary')
      ? `.pj-eta[data-eta="${CSS.escape(focused.parentElement.dataset.eta)}"] > summary`
      : focused?.matches('.pj-steps > summary')
        ? '.pj-steps > summary'
        : null;
  return selector && { selector, index: [...el.querySelectorAll(selector)].indexOf(focused) };
}
// Once the keys coming in under el (moveIn), and any other motion there that ends, are over, or SETTLE_MS on: a repaint
// waits for it rather than cutting them short. SETTLE_MS caps the wait so a stuck or very long animation never holds
// fresh data back. moveIn's slowest entrance, the last key dropped onto a tablet's view, ends within it (about 1.8 s);
// on a much taller screen, or with an entrance made longer, the repaint redraws what's still moving at rest
const SETTLE_MS = 2000;
export const settled = el =>
  Promise.race([
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .filter(a => a.effect?.getTiming().iterations !== Infinity)
        .map(a => a.finished.catch(() => {})),
    ),
    new Promise(done => setTimeout(done, SETTLE_MS)),
  ]);
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
