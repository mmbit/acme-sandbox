// The Notebook's pull tab: a fabric tab in the brand's accent on the cover's outer edge, all of the book that shows at
// the screen's edge while it's shut. Its tap opens the book, or closes it when open (its drag: book.js). It moves with
// the book and nudges no one: no count. (the pull tab, open and shut) A mark lifted
// off HQ into the folded book lands in it (book:landed, detail: { id, page, snip }: booklanding.js): the handle shows its
// snip small for a moment, and its tap then opens the book on that note; else the tap opens the book where it was.
// (the dot for an answer gone with the sheets it read)
import { tip } from './bookui.js';
import * as link from './notebooklink.js';

// How long a landed snip shows on the handle
const SNIP_MS = 2600;

let handle;
let landed = null; // (the note that last landed in the folded book, which the tap opens: { id, page, group })
let nudged = -Infinity; // (when the handle last nudged for one: a scrap's ink and then its scrap nudge it once)

// node: the tab's button; on: { open, fold, openOn({ page, id }), shut() }, the book's (book.js): shut() whether it's
// shut or swinging shut, so a tap mid-swing turns it round
export function mountHandle(node, on) {
  handle = node;
  tip(handle, () => handle.getAttribute('aria-label'));
  // (a tap: a hand that pulls and lets go at once, so an artifact hears where the notebook ends up.)
  handle.addEventListener('click', () => {
    const opening = on.shut();
    link.emit('pull');
    link.emit('letgo', { open: opening });
    if (!opening) on.fold();
    else if (landed) on.openOn(landed);
    else on.open();
  });
  document.addEventListener('book:landed', e => land(e.detail));
  // (opened, the book is where the note landed or the board's moved on: the tap's note is spent)
  document.addEventListener('book:layout', e => {
    if (e.detail.mode !== 'folded') landed = null;
    draw();
  });
  draw();
}

// What a tap does, said
function draw() {
  const does = !shut()
    ? 'tap or pull it to close'
    : landed
      ? 'a note just landed, tap to see it'
      : 'tap or pull it to open';
  handle.setAttribute('aria-label', `The Notebook: ${does}`);
}
const shut = () => (document.documentElement.dataset.book ?? 'folded') === 'folded';

// A note landed in the folded book: its snip tucked in beside the handle for a moment, the handle nudged as it comes
// (group: a Notebook scrap's, its id null while it's being made: the tap opens at it once it's in.)
function land({ id, page, snip, group = false }) {
  if (!shut()) return;
  if (id) landed = { id, page, group };
  draw();
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches,
    again = performance.now() - nudged < SNIP_MS;
  nudged = performance.now();
  if (!still && !again)
    handle.animate([{ scale: 1 }, { scale: 1.12 }, { scale: 1 }], { duration: 320, easing: 'ease-out' });
  if (!snip) return;
  handle.querySelector('.bk-snip')?.remove();
  const picture = Object.assign(document.createElement('img'), { className: 'bk-snip', src: snip, alt: '' });
  handle.append(picture);
  const away = { opacity: 0, transform: still ? 'rotate(-4deg)' : 'translateX(14px) rotate(-4deg) scale(0.55)' },
    shown = { opacity: 1, transform: 'rotate(-4deg)' };
  picture
    .animate([away, { ...shown, offset: 0.1 }, { ...shown, offset: 0.88 }, away], {
      duration: SNIP_MS,
      easing: 'ease-out',
    })
    .finished.then(
      () => picture.remove(),
      () => {},
    );
}
