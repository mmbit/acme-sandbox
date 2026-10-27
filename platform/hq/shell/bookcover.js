// The book's cover: its indigo cloth, a paper label with its owner's name, the red elastic down its edge. The book comes
// in shut (book.js shows the cover from the moment it moves), and as it lands the cover swings open round the spine and
// a few leaves riffle after it, staggered, onto the page: the same turn as a page's (bookflip.js), in about half a
// second. With reduced motion there's no cover: the book fades in. (the motion:
// job #19861)
import { esc } from '../util.js';
import * as world from '../world/world.js';
import { TURN, turnFrames } from './bookflip.js';

// (the name till HQ has read whose book it is)
const NAME = 'Sketchbook';
// The cover's swing, and the leaves after it: each this long, the first this long after the cover starts, the next
// these apart. Quicker than a page's turn: a riffle.
const COVER_MS = 300,
  LEAF_MS = 220,
  LEAF_AFTER = 60,
  LEAF_APART = 60,
  LEAVES = 3;

let root, leaf, cover, playing;

// The book's owner's name on its cover: "<the board's first member>'s book"
export function bookName() {
  const id = world.rooms.find(r => r.board)?.agentIds[0],
    name = id && world.agents.get(id)?.data.name;
  return name ? `${name}’s book` : NAME;
}

// root: #book; leafNode: the book's paper's section, which the cover lies over
export function mountCover(rootNode, leafNode) {
  root = rootNode;
  leaf = leafNode;
  cover = document.createElement('div');
  cover.className = 'bk-cover';
  cover.hidden = true;
  cover.setAttribute('aria-hidden', 'true');
  leaf.append(cover);
}

// The cover shut over the paper, the controls away (islands over a shut cover would float over nothing): the book as it
// comes in
export function shutCover() {
  if (!cover || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  stop();
  cover.innerHTML = `<div class="bk-cover-front"><span class="bk-cover-label"><b>${esc(bookName())}</b></span>
    <i class="bk-cover-band"></i></div>`;
  cover.hidden = false;
  root.classList.add('bk-opening');
}

// The cover swings open and the leaves riffle after it onto the page. wait: how long it stays shut first (ms: the
// book's slide in, as it lands)
export async function openCover({ wait = 0 } = {}) {
  if (!cover || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (cover.hidden) shutCover();
  stop();
  const at = turned(Math.min(leaf.offsetWidth, innerWidth));
  // (the first to turn lies on top, just under the cover: each leaf is painted over the ones before it)
  const leaves = Array.from({ length: LEAVES }, () => {
    const l = document.createElement('i');
    l.className = 'bk-cover-leaf';
    cover.before(l);
    return l;
  }).reverse();
  const mine = (playing = [
    ...swing(cover, wait, COVER_MS, at),
    ...leaves.flatMap((l, i) => swing(l, wait + LEAF_AFTER + i * LEAF_APART, LEAF_MS, at)),
  ]);
  await Promise.all(mine.map(a => a.finished.catch(() => {})));
  if (playing === mine) hideCover();
}

// The cover put away, open or not, its leaves gone (the book folded, or open)
export function hideCover() {
  stop();
  leaf?.querySelectorAll('.bk-cover-leaf').forEach(l => l.remove());
  if (!cover) return;
  cover.hidden = true;
  root.classList.remove('bk-opening');
}

function stop() {
  const was = playing;
  playing = null;
  was?.forEach(a => a.cancel());
}
// A turn round the spine, in the perspective of a book this wide: at(degrees) → a transform
const turned = w => {
  const depth = Math.round(Math.max(1400, w * 2.6));
  return d => `perspective(${depth}px) rotateY(${d}deg)`;
};
// One turn open round the spine (a page's: bookflip.js), its face darkening as it turns from the light (the ::after
// shade). The leaves riffle with the cover's ease, only quicker.
function swing(el, delay, ms, at) {
  const timing = { duration: ms, delay, easing: TURN.easing, fill: 'both' };
  return [
    el.animate(turnFrames(at), timing),
    el.animate([{ opacity: 0 }, { opacity: 1 }], { ...timing, pseudoElement: '::after' }),
  ];
}
