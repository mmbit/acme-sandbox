// A voice note's words on the page as they're heard (bookvoice.js): a box of words at the spot it was held, placed and
// wrapped as they'll land (booktexts.js spotFor), so nothing moves when they do, in the pen's ink and the book's face.
// After the words, while more are still coming, a loader of the same ink: three dots, swelling with the voice while
// the press is held, then rising in turn till the last words are in (README, A voice note at a spot). Only the moment's: the words land as a page's own box (book.tape.words) and this goes.
import { setBox, spotFor } from './booktexts.js';

const LOADER = '<span class="bk-hearing" aria-hidden="true"><i></i><i></i><i></i></span>';

// spot: { view, x, y }, a point on a view's page; color: the pen's. Returns { heard(words), level(lvl), held(), gone() }
export function heardAt({ view, x, y }, color) {
  const el = document.createElement('div');
  el.className = 'bk-heard';
  el.dataset.listening = '';
  el.setAttribute('role', 'status');
  el.innerHTML = '<div class="bk-typed-words"></div>';
  el.words = el.firstElementChild;
  setBox(el, { ...spotFor(view.page, { x, y }), text: '', color });
  el.words.innerHTML = `<span></span>${LOADER}`;
  const said = el.words.firstElementChild;
  let over = false;
  view.el.append(el);
  return {
    // every word so far: the new ones ink in
    heard(words) {
      const was = said.textContent;
      if (over || words === was) return;
      if (words.startsWith(was) && was) {
        const fresh = document.createElement('span');
        fresh.className = 'bk-heard-new';
        fresh.textContent = words.slice(was.length);
        said.replaceChildren(was, fresh);
      } else said.textContent = words;
    },
    level: lvl => el.style.setProperty('--lvl', lvl),
    // the press let go: the dots wait on the last words
    held() {
      delete el.dataset.listening;
      el.style.removeProperty('--lvl');
    },
    gone() {
      over = true;
      el.remove();
    },
  };
}
