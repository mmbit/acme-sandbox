// A call's card over HQ and the call alike, recorded as the board sees it: the call engine's (calldrive.js, and Ink's
// calldraw.js on it), so the engine reads nothing of Ink. (was calldraw.js's)
// The cards float over everything on the page, as the small call does, clear of it and of the page's controls.
import { clearSpot, floating, keptClear, room } from './floating.js';

const $ = s => document.querySelector(s);
// The narrowest the cards go where their own width fits nowhere clear (a phone's book open, or HQ's page beside it)
const NARROW_PX = 240;

export function cardOf(c, kind) {
  let box = $('#call-cards');
  if (!box) {
    box = Object.assign(document.createElement('div'), { id: 'call-cards' });
    box.setAttribute('data-keep-clear', ''); // (the small call keeps clear of them, as they do of it)
    addEventListener('resize', () => place(box));
    document.addEventListener('book:layout', () => place(box));
  }
  floating().append(box);
  box.querySelector(`[data-card="${kind}"]`)?.remove();
  const card = Object.assign(document.createElement('div'), { className: 'toast call-card' });
  card.dataset.card = kind;
  card.setAttribute('role', 'status'); // (read out as it comes, and nothing waits on it)
  box.append(card);
  queueMicrotask(() => place(box)); // (once the caller has written the card)
  return card;
}

// Where the stylesheet puts them (under HQ's tools in the middle of its page) if that's clear, else the nearest clear
// spot on the page or the whole screen (clear of the small call too, marked as the controls are), narrower when their
// own width fits nowhere
function place(box) {
  box.style.cssText = '';
  if (!box.children.length) return;
  const natural = box.getBoundingClientRect(),
    avoid = keptClear(box);
  for (const w of [natural.width, Math.min(natural.width, NARROW_PX)]) {
    box.style.width = `${w}px`;
    const size = { w, h: box.offsetHeight },
      at = { x: natural.left + (natural.width - w) / 2, y: natural.top },
      spot = clearSpot(
        size,
        [room(), room({ whole: true })].map(r => ({ room: r, at })),
        avoid,
      );
    if (spot) return Object.assign(box.style, { left: `${spot.x}px`, top: `${spot.y}px`, transform: 'none' });
  }
  box.style.cssText = '';
}
