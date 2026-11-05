// Settings › Call marks in the Notebook, this device's, off until the board turns it on (as Pin on HQ is:
// pinsetting.js). Off, the Notebook's pen is the book's own on a call too: it draws notebook ink and taps its menus
// (pentouch.js ownsPen). On, while a call is on (calldraw.js's call:on and call:off), the paper is marked
// data-takes-ink in place of data-no-ink: the call's pen (review mode's) marks it as it marks HQ's page, its line a note
// for the call's agent shown over the page (layer.js showSpread), while the book's tools, cards and menus stay the
// book's, and so does the overview's title line on the paper (bookshelf.js, marked data-no-ink).
// The book's parts that are no page to write on (the Shelf's window: bookshelfwindow.js) take the call's pen on any
// call, whatever Settings say: on a call the board scribbles anywhere.
import { store } from '../../util.js';

let calling = false,
  paper = null;
const unpaged = new Set(); // (takesCallInk's.)

// paper: the book's (book.js mountRoot)
export function mountCallMarks(el) {
  paper = el;
  document.addEventListener('call:on', () => onCall(true));
  document.addEventListener('call:off', () => onCall(false));
  paint();
}
export const callMarksOn = () => store.get('bookCallMarks', false);
export function setCallMarks(on) {
  store.set('bookCallMarks', on);
  paint();
}

// A part of the book that's no page, the call's pen's while a call is on
export function takesCallInk(el) {
  unpaged.add(el);
  paint();
}

function onCall(on) {
  calling = on;
  paint();
}
function paint() {
  const marks = calling && callMarksOn();
  paper?.toggleAttribute('data-no-ink', !marks);
  paper?.toggleAttribute('data-takes-ink', marks);
  for (const el of unpaged) el.toggleAttribute('data-takes-ink', calling);
}
