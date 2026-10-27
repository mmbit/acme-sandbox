// The folded book's handle: a tab of the book's cloth sewn to its spine, all of the book that shows at the screen's edge.
// It moves with the book (book.js drags it) and nudges no one: no count, only a dot for an answer to read. A mark lifted
// off HQ into the folded book lands in it (book:landed, detail: { id, page, snip }: booklanding.js): the handle shows its
// snip small for a moment, and its tap then opens the book on that note; else the tap opens the book where it was. It
// reads the answers from the sheets the rail reads (book:sheets: bookrail.js).
import * as world from '../world/world.js';
import { facesOf } from './bookfaces.js';
import { tip } from './bookui.js';
import { bookName } from './bookcover.js';

// How long a landed snip shows on the handle
const SNIP_MS = 2600;

let handle,
  unread = false;
let landed = null; // (the note that last landed in the folded book, which the tap opens: { id, page })

// node: the handle's button; on: { open, openOn({ page, id }) }, the book's (book.js)
export function mountHandle(node, on) {
  handle = node;
  tip(handle, () => handle.getAttribute('aria-label'));
  handle.addEventListener('click', () => (landed ? on.openOn(landed) : on.open()));
  document.addEventListener('book:sheets', e => {
    unread = facesOf(e.detail, world.company.ceo).some(f => f.dot);
    draw();
  });
  document.addEventListener('book:landed', e => land(e.detail));
  // (opened, the book is where the note landed or the board's moved on: the tap's note is spent)
  document.addEventListener('book:layout', e => e.detail.mode !== 'folded' && (landed = null));
  draw();
}

// The handle's dot for an answer, and what a tap does, said
function draw() {
  const dot = handle.querySelector('.bk-dot');
  if (unread && !dot) handle.append(Object.assign(document.createElement('i'), { className: 'bk-dot' }));
  if (!unread) dot?.remove();
  handle.setAttribute(
    'aria-label',
    `${bookName()}: ${landed ? 'a note just landed, tap to see it' : 'tap or pull it in'}${unread ? ' (an answer to read)' : ''}`,
  );
}

// A note landed in the folded book: its snip tucked in beside the handle for a moment, the handle nudged as it comes
function land({ id, page, snip }) {
  if (document.documentElement.dataset.book !== 'folded') return;
  landed = { id, page };
  draw();
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!still) handle.animate([{ scale: 1 }, { scale: 1.12 }, { scale: 1 }], { duration: 320, easing: 'ease-out' });
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
