// The Shelf in its own window, floating over HQ. HQ's Shelf key opens it, and
// the book's way back to it shuts the book first (book.js). Every notebook stands on it as bookshelf.js draws them,
// with the Archive beside it; a notebook tapped puts the window away and opens in the book. A modal <dialog> in #book,
// so the book's paper and styles are its own, in the top layer over everything: it rises in and sinks away (a fade
// with reduced motion). Esc, its Close or a tap beside it puts it away. On its top at the right, a little potted plant
import { stylesheet } from '../../util.js';
import { mountScreens } from './bookshelf.js';
import { lineIcon } from './bookui.js';
import { aimAt } from './booknewest.js';
import { swinging } from './bookswing.js';

stylesheet('shell/ink/bookshelfwindow.css');

// Rising in, quick and soft as the book's slide; sinking away, quicker
const RISE = { duration: 220, easing: 'cubic-bezier(0.2, 0.75, 0.25, 1)' },
  SINK = { duration: 160, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' };
const LIFT = 'translateY(14px) scale(0.97)';
const CLOSE = lineIcon('<path d="M6 6l12 12M18 6L6 18"/>');
// (the plant as the shelf's design drew it: a small pot, its leaves fanning up in a spiky crown, in the book's ink;
// dots shade the pot's right)
const PLANT = `<svg class="bk-shelf-plant" viewBox="0 0 48 60" aria-hidden="true">
  <defs><pattern id="bk-plant-dots" width="3" height="3" patternUnits="userSpaceOnUse">
    <circle cx="1.5" cy="1.5" r="0.55"/></pattern></defs>
  <g class="bk-plant-leaves">
    <path d="M20.5 38C13 33.5 7.5 29.5 2.5 23.5C10.5 26 17 30.5 23 37.5Z"/>
    <path d="M27.5 38C35 34 40.5 30 45.5 25C37.5 27 31 31 25 37.5Z"/>
    <path d="M21 38C16.5 29 13 20.5 11 11.5C17 19 21.5 27.5 24 37.5Z"/>
    <path d="M27 38C31 29.5 34.5 21.5 37 13C30.5 20 26.5 28 24 37.5Z"/>
    <path d="M22 38C21 27 21.5 15.5 24.5 3.5C27 15.5 27.5 27 26.5 38Z"/>
  </g>
  <path class="bk-plant-pot" d="M12 44.5L14.5 59H33.5L36 44.5Z"/>
  <path class="bk-plant-shade" d="M28.5 45.5H35L32.7 58H28.5Z"/>
  <rect class="bk-plant-pot" x="9.5" y="37.5" width="29" height="7" rx="1.5"/>
</svg>`;
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let on = null; // the window: mountShelfWindow's

// host: #book. dev: on mock data. pages: bookpages.js's answer; open(), fold(): book.js's openBook and foldBook.
export function mountShelfWindow(host, { dev, pages, open, fold }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'bk-shelf-window';
  dialog.setAttribute('aria-label', 'The Shelf');
  dialog.innerHTML = `<div class="bk-far"></div>${PLANT}`;
  host.append(dialog);
  const w = (on = { dialog, fold, going: null, keep: false });
  w.screens = mountScreens(dialog.querySelector('.bk-far'), {
    dev,
    current: () => pages.notebook(),
    saved: async () => {},
    // (a notebook tapped: the window away, the notebook read in while the book's shut, then the book opens on it)
    notebook: async id => {
      hide(w);
      await pages.open(id);
      aimAt('place');
      open();
    },
    // (a returned round unwrapped: the same, the book opening on its first Advice page, bookshelfround.js)
    open: async (page, id) => {
      hide(w);
      await pages.open(id, page.id);
      aimAt('place');
      open();
    },
  });
  dialog
    .querySelector('.bk-far-head')
    .insertAdjacentHTML(
      'beforeend',
      `<button type="button" class="bk-far-go bk-shelf-close" aria-label="Close the Shelf">${CLOSE}</button>`,
    );
  dialog.querySelector('.bk-shelf-close').addEventListener('click', () => hide(w));
  // (Esc shuts a book's own menu first: bookshelf.js's keys, under the window's own)
  dialog.addEventListener('keydown', e => (w.keep = e.key === 'Escape' && !!dialog.querySelector('.bk-book-menu')), {
    capture: true,
  });
  dialog.addEventListener('cancel', e => {
    e.preventDefault();
    if (!w.keep) hide(w);
    w.keep = false;
  });
  // (a tap beside it, on the backdrop, lands on the dialog itself)
  dialog.addEventListener('click', e => e.target === dialog && hide(w));
}

// The Shelf shown (HQ's Shelf key, the book's way back to it): an open book shut first, its close played, then the
// Shelf. A promise, once the book is shut.
export function openShelf() {
  if (!on) return;
  if (document.documentElement.dataset.book === 'folded' && !swinging()) return void show(on);
  return new Promise(done => {
    document.addEventListener(
      'book:layout',
      e => {
        if (e.detail.mode === 'folded') show(on);
        done();
      },
      { once: true },
    );
    on.fold();
  });
}

function show(w) {
  const { dialog } = w;
  if (dialog.open && !w.going) return;
  w.going?.cancel();
  w.going = null;
  dialog.classList.remove('bk-sinking');
  if (!dialog.open) dialog.showModal();
  w.screens.show('shelf');
  dialog.animate(
    [
      { opacity: 0, transform: still() ? 'none' : LIFT },
      { opacity: 1, transform: 'none' },
    ],
    RISE,
  );
}
// Away: it sinks and fades, its backdrop with it (bookshelfwindow.css), then closes
function hide(w) {
  const { dialog } = w;
  if (!dialog.open || w.going) return;
  dialog.classList.add('bk-sinking');
  const going = (w.going = dialog.animate(
    [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: still() ? 'none' : LIFT },
    ],
    SINK,
  ));
  going.finished.then(
    () => {
      if (w.going !== going) return;
      w.going = null;
      dialog.close();
      dialog.classList.remove('bk-sinking');
      going.cancel();
      w.screens.hide();
    },
    () => {} /* cancelled: the Shelf shown again mid-sink (show) */,
  );
}
