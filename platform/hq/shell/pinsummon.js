// HQ's pin (review mode, shared/review), the mouse's and a finger's way to mark HQ (the Pencil writes on it anyway):
// away as HQ loads, whatever the book's state, until the board summons it. Beside the book (a desktop, a tablet) the
// act of opening the book summons it, and so does the pin among the book's controls; folding the book or that control
// puts it away. The spread (a phone's open book, an iPad's upright until its cover's edge is drawn right) covers HQ's
// page: there the control folds the book and leaves HQ with the pin on it, and opening it as the spread again puts it
// away. Review mode shows and hides it ('review:summon': dock.js) with its quick pop and shrink. (the board, 2026-10-27)
import { bookLayout, foldBook } from './ink/book.js';
import { button, island, lineIcon, setPressed } from './ink/bookui.js';

// a pushpin in the islands' own line, tilted as review mode's pin is
const ICON = lineIcon(
  '<g transform="rotate(45 12 12)"><path d="M9 3h6l-.8 5.5L17 11v2H7v-2l2.8-2.5z"/><path d="M12 13v8"/></g>',
);

let out = false,
  control,
  was = null; // (the book's mode at its last layout)

// The control in the book's island, under Undo and Redo, and the book's moves heard
export function mountPinSummon() {
  control = button({
    icon: ICON,
    label: 'Pin a note on HQ',
    onClick: toggled,
    pressed: false,
  });
  control.classList.add('bk-pin');
  island('book').append(control);
  was = document.documentElement.dataset.book ?? null; // (laid out before HQ's desk starts)
  document.addEventListener('book:layout', moved);
}
// What the pin is now, told again (review mode just loaded)
export const tellPin = () => dispatchEvent(new CustomEvent('review:summon', { detail: out }));

function summon(on) {
  if (on === out) return;
  out = on;
  setPressed(control, on);
  tellPin();
}
// (from the book as it lies now: an upright iPad's book drawn beside HQ is open, not the spread.)
function toggled() {
  if (bookLayout().mode !== 'spread') return summon(!out);
  summon(true);
  foldBook();
}
// Beside the book: opened by the board (act: not HQ's start or a new window size), the pin comes; folded, it goes. The
// spread covers HQ: the pin goes as it opens, and folding it leaves the pin as the control set it.
function moved({ detail: { mode, act } }) {
  const from = was;
  was = mode;
  if (mode === 'spread') summon(false);
  else if (mode === 'folded') {
    if (from === 'open') summon(false);
  } else if (act && from === 'folded') summon(true);
}
