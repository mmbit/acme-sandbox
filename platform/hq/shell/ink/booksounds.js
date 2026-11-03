// The notebook's sounds, one table of its moments (shared/craft/sound.md), each the paper or card it is, from the
// platform's sound kit (foley.js). A press is the softest, a fingertip's tap on
// card as quiet as the faintest click. What the paper does stands a little over it. Every press in the book is heard
// here, its toasts' taps too (toastHeard), so no control's handler plays one of its own.
import { foley } from '../audio.js';
import { toast } from '../toast.js';

// A moment: its sounds, [kit sound, params, { vol, at: s after the moment starts }]
const MOMENTS = {
  press: [['hit', { material: 'card', size: 0.5, force: 0.3 }, { vol: 0.24 }]],
  // balled up: the crunch as it's squeezed (bookpaper.js crumple), and the ball landing out of sight once thrown
  crumple: [['crunch', { dur: 0.3, dry: 0.3 }, { vol: 0.35 }]],
  thrown: [['hit', { material: 'card', size: 1.2, force: 0.3 }, { vol: 0.2 }]],
  // folded in half, the crease pressed down as it closes (bookpaper.js fold)
  fold: [['flip', { material: 'paper', dur: 0.3 }, { vol: 0.3 }]],
  // a round's envelope, on bookshelfround.css's times: wrapped, the cover slides in, the flap comes down and the string
  // winds round; unwrapped, the string unwinds, the flap opens (landing as it's open) and the Advice slides out
  wrap: [
    ['slide', { dur: 0.45, material: 'paper', size: 0.8 }, { vol: 0.85 }],
    ['hit', { material: 'card', size: 1.8, force: 0.2 }, { vol: 0.18, at: 0.62 }],
    ['slide', { dur: 0.35, material: 'paper', size: 0.3 }, { vol: 0.75, at: 0.9 }],
  ],
  unwrap: [
    ['slide', { material: 'paper', dur: 0.5, size: 0.4 }, { vol: 0.8 }],
    ['flip', { material: 'paper', dur: 0.45 }, { vol: 0.25, at: 0.55 }],
    ['slide', { material: 'paper', dur: 0.55, size: 0.8 }, { vol: 0.85, at: 0.95 }],
  ],
};
// The moment's sounds, at s seconds from now
export const heard = (moment, s = 0) =>
  MOMENTS[moment].forEach(([name, params, { vol, at = 0 }]) => foley(name, params, { vol, at: at + s }));

// Every press in root (book.js's #book: the rail's button()s and every other control, menus, cards and the Shelf
// window) answers at once with the same soft tap, pressed by a pointer or a key
const PRESSES = [
  'button',
  'a[href]',
  '[role=button]',
  '[role^=menuitem]',
  '[role=tab]',
  '[role=option]',
  'summary',
  'input[type=checkbox]',
  'input[type=radio]',
].join(', ');
export function pressesHeard(root) {
  root.addEventListener('click', e => e.target.closest?.(PRESSES) && heard('press'), { capture: true });
}
// The book's toast whose tap does something (an Undo, a page to go to): HQ's own, outside root, its tap heard the same
export const toastHeard = (html, tapped) =>
  toast(html, () => {
    heard('press');
    tapped();
  });
