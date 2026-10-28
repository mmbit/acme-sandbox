// HQ's pin (review mode, shared/review), the mouse's and a finger's way to mark HQ (the Pencil writes on it anyway):
// away as HQ loads, whatever the book's state, until the board summons it. Beside the book (a desktop, a tablet) the
// act of opening the book summons it, and so does the pin among the book's controls; folding the book or that control
// puts it away. A phone has no room for HQ's page beside the open book (it opens as the spread over HQ): there the
// control folds the book and leaves HQ with the pin on it, and opening the book again puts it away. Review mode shows
// and hides it ('review:summon': dock.js) with its quick pop and shrink. (the board, 2026-10-27)
import { foldBook } from './ink/book.js';
import { layout } from './ink/booklayout.js';
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

// The open book would be the spread here: a phone
const phone = () => layout(innerWidth, innerHeight, { mode: 'open', book: null }).mode === 'spread';

function summon(on) {
  if (on === out) return;
  out = on;
  setPressed(control, on);
  tellPin();
}
function toggled() {
  if (!phone()) return summon(!out);
  summon(true);
  foldBook();
}
// Beside the book: opened by the board (act: not HQ's start or a new window size), the pin comes; folded, it goes. On a
// phone the open book covers HQ: the pin goes as it opens, and folding it leaves the pin as the control set it.
function moved({ detail: { mode, act } }) {
  const folded = mode === 'folded',
    opened = act && was === 'folded' && !folded;
  was = mode;
  if (phone()) {
    if (!folded) summon(false);
  } else if (folded) summon(false);
  else if (opened) summon(true);
}
