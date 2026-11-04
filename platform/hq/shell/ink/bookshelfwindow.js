// The Shelf in its own window, floating over HQ: a bookcase. HQ's Shelf key opens it, and the book's way back to it
// shuts the book first (book.js). Every notebook stands on its boards as bookshelf.js draws them, with the Archive's
// box; a notebook tapped puts the window away and opens the book on its pages. A modal <dialog> in #book, so the book's
// styles are its own, in the top layer over everything: it rises in and sinks away (a fade with reduced motion). Esc,
// its Close or a tap beside it puts it away. On a phone it fills the screen. Its shelf is read ahead, as HQ opens and
// each time it's put away, so it opens whole.
import { stylesheet } from '../../util.js';
import { icon } from '../icons.js';
import { mountScreens } from './bookshelf.js';
import { aimAt } from './booknewest.js';
import { swinging } from './bookswing.js';

stylesheet('shell/ink/bookshelfwindow.css');

// Rising in, quick and soft as the book's slide; sinking away, quicker
const RISE = { duration: 220, easing: 'cubic-bezier(0.2, 0.75, 0.25, 1)' },
  SINK = { duration: 160, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' };
const LIFT = 'translateY(14px) scale(0.97)';
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let on = null; // the window: mountShelfWindow's

// host: #book. dev: on mock data. pages: bookpages.js's answer; open(), fold(): book.js's openBook and foldBook.
export function mountShelfWindow(host, { dev, pages, open, fold }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'bk-shelf-window';
  dialog.setAttribute('aria-label', 'The Shelf');
  dialog.innerHTML = '<div class="bk-far" tabindex="-1"></div>';
  host.append(dialog);
  const w = (on = { dialog, fold, going: null });
  w.screens = mountScreens(dialog.querySelector('.bk-far'), {
    dev,
    current: () => pages.notebook(),
    saved: async () => {},
    // (a notebook tapped: the window away, the notebook read in while the book's shut, then the book opens on its
    // pages)
    notebook: async id => {
      hide(w);
      await pages.open(id);
      pages.overview();
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
      `<button type="button" class="bk-shelf-close" aria-label="Close the Shelf">${icon('close')}</button>`,
    );
  dialog.querySelector('.bk-shelf-close').addEventListener('click', () => hide(w));
  dialog.addEventListener('cancel', e => {
    e.preventDefault();
    hide(w);
  });
  // (a tap beside it, on the backdrop, lands on the dialog itself)
  dialog.addEventListener('click', e => e.target === dialog && hide(w));
  w.screens.ahead();
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
  if (!dialog.open) {
    dialog.showModal();
    // (the focus on its bookcase, which scrolls by the keys, rather than ringing its Close)
    dialog.querySelector('.bk-far').focus({ preventScroll: true });
  }
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
      w.screens.ahead();
    },
    () => {} /* cancelled: the Shelf shown again mid-sink (show) */,
  );
}
