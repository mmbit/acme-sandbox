// A leaf of the book turning: the one quick page-turn every change of page uses (a page to the next, to and from the
// overview, the book opening: bookcover.js), so they all feel the same. turn(paper, { dir, midway }): forward (dir 1)
// the page shown lifts at its outer edge and turns over towards the spine, the new page already under it; back (dir -1)
// the page before swings back from the spine onto the page shown: the same turn played backwards, frame for frame.
// midway() swaps what's under the leaf while the leaf hides it (it may return a promise). The leaf is a picture of a page
// (its parts copied, its canvases' pixels too), so nothing on the page flashes or jumps. Transforms and opacity only:
// the compositor's. Reduced motion: the page shown fades into the new one. (the
// turn the same both ways: job #19861)

// A turn: quick, the leaf lifting at first and gone over the spine as it speeds up; played back, it sweeps in and
// settles. (bookcover.js's cover and leaves turn with its ease.)
export const TURN = { ms: 300, easing: 'cubic-bezier(0.42, 0.05, 0.72, 0.62)' };
// Reduced motion's cross-fade
const FADE_MS = 140;

const running = new WeakMap(); // (el → the turn under way, finished at once if another starts)

// A leaf's turn from lying on the page to past edge on over the spine, at(degrees) → its transform
export const turnFrames = at => [{ transform: at(0) }, { transform: at(-100) }];

export async function turn(el, { dir = 1, midway = () => {} } = {}) {
  running.get(el)?.finish();
  if (!el.isConnected || !el.clientWidth) {
    await midway();
    return;
  }
  const layers = [],
    anims = [];
  const done = { finish: () => anims.forEach(a => a.finish()) };
  running.set(el, done);
  const add = node => (el.append(node), layers.push(node), node);
  try {
    const shown = add(picture(el));
    await midway();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches)
      anims.push(shown.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, fill: 'forwards' }));
    else if (dir >= 0) {
      // forward: the page shown, as a leaf, lifts off the new page swapped in under it
      shown.remove();
      anims.push(...swing(leafOf(shown, el, add), el, 'normal'));
    } else {
      // back: the page before, as a leaf, swings back onto the page shown (its picture, till the leaf is down)
      await frame();
      anims.push(...swing(leafOf(picture(el), el, add), el, 'reverse'));
    }
    await Promise.all(anims.map(a => a.finished.catch(() => {})));
  } finally {
    layers.forEach(n => n.remove());
    if (running.get(el) === done) running.delete(el);
  }
}

// A leaf's turn, forward or played backwards: the leaf round the spine (the paper's left edge), its face shading as it
// turns from the light, and the shadow it throws on the page under it
function swing(leaf, el, direction) {
  // (the perspective in the leaf's own transform: on the paper it would make it a box for its fixed parts)
  const depth = Math.round(Math.max(1600, el.clientWidth * 2.4)),
    opts = { duration: TURN.ms, easing: TURN.easing, fill: 'both', direction };
  const shade = leaf.querySelector('.bk-turn-shade'),
    cast = leaf.previousElementSibling,
    at = d => `perspective(${depth}px) rotateY(${d}deg)`;
  return [
    leaf.animate(turnFrames(at), opts),
    shade.animate([{ opacity: 0 }, { opacity: 1 }], opts),
    cast.animate([{ opacity: 0.55 }, { opacity: 0 }], opts),
  ];
}

// The leaf: a picture of a page, hinged at the spine, its face shaded as it turns, a shadow under it on the page (both
// put on the paper by add, over what's there)
function leafOf(face, el, add) {
  const leaf = document.createElement('div');
  leaf.className = 'bk-turn-leaf';
  leaf.style.cssText = `position:absolute;inset:0;z-index:30;transform-origin:0 50%;backface-visibility:hidden;
    pointer-events:none;will-change:transform;box-shadow:0 0 24px rgba(20,14,40,.35)`;
  face.style.position = 'absolute';
  face.style.inset = '0';
  const shade = document.createElement('i');
  shade.className = 'bk-turn-shade';
  // the curl: darker towards the outer edge that's lifting, lit along the spine
  shade.style.cssText = `position:absolute;inset:0;opacity:0;pointer-events:none;
    background:linear-gradient(90deg,rgba(20,14,40,.05),rgba(20,14,40,.28) 70%,rgba(20,14,40,.5))`;
  leaf.append(face, shade);
  const under = document.createElement('div');
  under.className = 'bk-turn-under';
  // the shadow the leaf throws on the page it uncovers, deepest at the spine
  under.style.cssText = `position:absolute;inset:0;z-index:29;opacity:0;pointer-events:none;
    background:linear-gradient(90deg,rgba(20,14,40,.45),rgba(20,14,40,.12) 45%,rgba(20,14,40,0))`;
  add(under);
  return add(leaf);
}

// A picture of what el shows now: its parts copied, the pixels of its canvases too, its scrolled boxes where they were,
// over it exactly and taking no presses
export function picture(el) {
  const copy = document.createElement('div');
  copy.className = 'bk-turn-picture';
  const box = getComputedStyle(el);
  copy.style.cssText = `position:absolute;inset:0;overflow:hidden;z-index:28;pointer-events:none;
    background-color:${box.backgroundColor};background-image:${box.backgroundImage};background-size:${box.backgroundSize};
    background-position:${box.backgroundPosition}`;
  // the paper's own background is the book's (.bk-leaf): a picture over a see-through paper needs it
  if (box.backgroundColor === 'rgba(0, 0, 0, 0)' && box.backgroundImage === 'none') {
    const leaf = el.closest('.bk-leaf') ?? el.parentElement;
    if (leaf) {
      const lb = getComputedStyle(leaf);
      copy.style.backgroundColor = lb.backgroundColor;
      copy.style.backgroundImage = lb.backgroundImage;
      copy.style.backgroundSize = lb.backgroundSize;
    }
  }
  const scrolled = [];
  for (const child of el.children) {
    if (child.classList.contains('bk-turn-picture') || child.className.startsWith?.('bk-turn')) continue;
    const c = child.cloneNode(true);
    pair(child, c, scrolled);
    copy.append(c);
  }
  copy.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
  // (a picture only: nothing in it is pressed, nor read aloud twice beside the page it shows)
  copy.inert = true;
  copy.setAttribute('aria-hidden', 'true');
  // (scroll positions hold only once the copy is in the page)
  queueMicrotask(() => scrolled.forEach(([n, x, y]) => ((n.scrollLeft = x), (n.scrollTop = y))));
  return copy;
}
// Walk an original and its copy together: canvases' pixels copied, scrolled boxes noted
function pair(a, b, scrolled) {
  if (a instanceof HTMLCanvasElement) {
    try {
      b.getContext('2d')?.drawImage(a, 0, 0);
    } catch {
      /* a canvas drawn elsewhere (WebGL, tainted): its copy stays blank */
    }
    return;
  }
  if (a.scrollTop || a.scrollLeft) scrolled.push([b, a.scrollLeft, a.scrollTop]);
  const ka = a.children,
    kb = b.children;
  for (let i = 0; i < ka.length && i < kb.length; i++) pair(ka[i], kb[i], scrolled);
}
const frame = () => new Promise(r => requestAnimationFrame(() => r()));
