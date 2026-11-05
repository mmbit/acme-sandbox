// Assigning's motion (bookassign.js): the line out of a ring drawn in ink over the page (under the list it opens), a
// copy of the scrap flying to the name (or page) picked (along that line, else on a gentle curve), shrinking as it goes and landing at their initial,
// and what's done tidied away. The copies take no press, and the scrap itself never moves. With reduced motion, no
// flight: things fade.
import { foley } from '../audio.js';
import { thingsPicture } from './bookpaperdraw.js';
import { boundsOf } from './bookselectmath.js';
import { boxOfText } from './bookselect.js';
import { bowed, evenly } from './bookassignmath.js';

// the flight (ms), its keyframes, how long the copy rests at the name before things tidy away, and their fade
const FLY_MS = 750,
  STEPS = 24,
  REST_MS = 450,
  TIDY_MS = 350;
// the copy lands this big (px, its longer side), about the initial's circle
const LANDS_PX = 44;
const SVG = 'http://www.w3.org/2000/svg';

// The line drawn over the page: { el, path, screen(points), draw(path) }, path in the page's px (bookselect.js
// pageOf's), drawn on the screen
export function lineOver(book) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'bk-assign-line');
  svg.setAttribute('aria-hidden', 'true');
  svg.append(document.createElementNS(SVG, 'path'));
  home().append(svg);
  const line = {
    el: svg,
    path: [],
    screen: points => points.map(p => onScreen(book, p)),
    draw(path) {
      line.path = path;
      svg.firstChild.setAttribute(
        'd',
        `M${line
          .screen(path)
          .map(p => p.join(' '))
          .join('L')}`,
      );
    },
  };
  return line;
}
// A point of the page (px) on the screen
function onScreen(book, [x, y]) {
  const r = book.desk.getBoundingClientRect();
  return [r.left + (x - book.pan.x) * book.scale, r.top + (y - book.pan.y) * book.scale];
}

// A copy of a scrap ({ view, things }) flown to a row's initial, along points on the screen (null: a curve of its own),
// with a paper's slide and a soft knock as it lands; resolved once it has rested there, gone
export async function flight(sel, { view, things }, row, along) {
  const extent = boundsOf(things, t => boxOfText(sel, t)),
    [rect, canvas] = thingsPicture(view, things, extent, sel.book.scale);
  if (still()) return wait(REST_MS);
  const copy = document.createElement('div');
  copy.append(canvas);
  return fly(copy, rect, row, along);
}

// A copy (an element, its look inside it) flown from a box on the screen (a DOMRect) to a row's mark (its first
// child: a person's initial, a page's icon), along points on the screen (null: a curve of its own), shrinking as it
// goes, with a paper's slide and a soft knock as it lands; resolved once it has rested there, gone.
export async function fly(copy, rect, row, along) {
  const face = row.firstElementChild.getBoundingClientRect(),
    from = [rect.left + rect.width / 2, rect.top + rect.height / 2],
    to = [face.left + face.width / 2, face.top + face.height / 2];
  if (still()) return wait(REST_MS);
  copy.classList.add('bk-assign-copy');
  Object.assign(copy.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  home().append(copy);
  const route = along?.length ? evenly([from, ...along, to], STEPS) : bowed(from, to, STEPS),
    k = Math.min(1, LANDS_PX / Math.max(rect.width, rect.height));
  const frames = route.map(([x, y], i) => {
    const t = i / STEPS,
      turn = Math.sin(t * Math.PI) * -9 - t * 6;
    return { transform: `translate(${x - from[0]}px, ${y - from[1]}px) rotate(${turn}deg) scale(${1 + (k - 1) * t})` };
  });
  foley('slide', { dur: 0.7, material: 'paper' }, { vol: 0.6 });
  foley('knock', { size: 0.8 }, { vol: 0.35, at: FLY_MS / 1000 });
  await copy.animate(frames, { duration: FLY_MS, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' }).finished;
  row.animate([{ scale: 1 }, { scale: 1.04 }, { scale: 1 }], { duration: 220, easing: 'ease-out' });
  await wait(REST_MS);
  tidy([copy]);
}

// A scrap's card on the grid copied to fly (fly's copy): its paper, and over it what of its group shows on the screen
// (its ink's canvas, its words, data-g's), each where it shows; canvases with their pictures
export function cardCopy(card, view) {
  const copy = document.createElement('div'),
    box = card.getBoundingClientRect(),
    k = box.width / (card.offsetWidth || 1);
  copy.dataset.card = '';
  const parts = [card, ...view.el.querySelectorAll(`[data-g="${card.dataset.unit}"]:not(.bk-tags, .bk-seen)`)];
  for (const el of parts) {
    const r = el.getBoundingClientRect();
    let part;
    if (el instanceof HTMLCanvasElement) {
      part = document.createElement('canvas');
      Object.assign(part, { width: el.width, height: el.height });
      part.getContext('2d')?.drawImage(el, 0, 0);
      Object.assign(part.style, { width: `${r.width}px`, height: `${r.height}px` });
    } else {
      part = el.cloneNode(true);
      Object.assign(part.style, { width: `${el.offsetWidth}px`, transform: `scale(${k})`, transformOrigin: '0 0' });
    }
    Object.assign(part.style, {
      position: 'absolute',
      margin: '0',
      left: `${r.left - box.left}px`,
      top: `${r.top - box.top}px`,
    });
    copy.append(part);
  }
  return copy;
}

// Elements faded away and gone
export function tidy(els) {
  for (const el of els) {
    if (!el.isConnected) continue;
    const fade = el.animate([{ opacity: 1 }, { opacity: 0, scale: 0.96 }], {
      duration: still() ? 0 : TIDY_MS,
      easing: 'ease-in',
      fill: 'forwards',
    });
    fade.finished.then(
      () => el.remove(),
      () => el.remove(),
    );
  }
}

const home = () => document.getElementById('book') ?? document.body;
const wait = ms => new Promise(r => setTimeout(r, ms));
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
