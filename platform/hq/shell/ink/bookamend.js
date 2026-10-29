// The pen's edits on words in the book (shared/review/penwords.js): a stroke drawn over a box of words on a page
// (booktexts.js) or over a scrap's post-it words (bookgroups.js) strikes words out or slices the text open, rather
// than staying as ink. A strike is one step Undo takes back. A slice opens a gap: the Pencil writes in it (read as
// handwriting and put in, a step each time), a mouse's slice puts the keyboard's caret there.
import { amendOf, openGap, strikeOut } from '/__review/penwords.js';
import { readWords } from '/__review/written.js';
import { notebookRequest } from './bookscope.js';
import { said } from './booksave.js';

// The words the pen edits on a page: boxes of words not being typed in, and a scrap's words (a field only while its
// page is open: bookgroups.js)
const WORDS = '.bk-typed:not([data-editing]) > .bk-typed-words, textarea.bk-scrap-words';

// book: bookpages.js's; texts: booktexts.js's. Returns { claim(stroke, pointer) }: a line just drawn (book.ink's, in
// the desk's px) by a pointer ('pen' | 'mouse' | 'touch'), which edits words it's over (true) rather than staying as
// ink. A hand's slice (the pen's, a finger's) is written in; a mouse's is typed in.
export function mountAmend(book, texts) {
  return { claim: (stroke, pointer) => claim(book, texts, stroke, pointer) };
}

function claim(book, texts, stroke, pointer) {
  const desk = book.desk.getBoundingClientRect(),
    points = stroke.points.map(([x, y, p]) => [x + desk.left, y + desk.top, p]);
  const xs = points.map(p => p[0]),
    ys = points.map(p => p[1]),
    reach = { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  for (const el of book.world.querySelectorAll(WORDS)) {
    if (!meets(el.getBoundingClientRect(), reach)) continue;
    const edit = amendOf(el, points);
    if (!edit) continue;
    const owner = ownerOf(book, texts, el);
    if (edit.kind === 'strike') strikeOut(el, edit, points, { put: owner.put, color: stroke.color });
    else sliced(book, owner, edit.at, pointer !== 'mouse');
    return true;
  }
  return false;
}
const meets = (a, b) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;

// Who keeps the words: { el, put(text) (kept as typed, a step), caret(at) (the keyboard's caret there), page }
function ownerOf(book, texts, el) {
  const box = el.closest('.bk-typed');
  if (box)
    return {
      el,
      page: box.view.page,
      put: text => texts.rewrite(box, text),
      // (the box opened for typing first: its words' place changes as it opens, and the gap is laid over them then)
      caret: at => texts.edit(box, null, at),
    };
  const id = el.closest('[data-g]').dataset.g,
    page = book.views.find(v => v.el.contains(el))?.page;
  return {
    el,
    page,
    put: text => {
      const was = field(book, id)?.value ?? '';
      write(book, id, text);
      book.steps.push({ undo: () => write(book, id, was), redo: () => write(book, id, text) });
    },
    caret: at => {
      el.focus({ preventScroll: true });
      el.setSelectionRange(at, at);
    },
  };
}
// A scrap's words written in its field, as if typed: its 'input' saves them to its group (bookgroups.js). The field
// may have been drawn again since: the one there now, under its group (data-g). pen: its keepFromScribble.
const field = (book, id) => book.world.querySelector(`[data-g="${id}"] textarea.bk-scrap-words`);
function write(book, id, text) {
  const f = field(book, id);
  if (!f) return;
  f.value = text;
  f.dispatchEvent(new Event('input'));
  f.pen?.refresh();
}

// The text sliced open: a hand's writing goes in the gap, read as handwriting; a mouse's slice gives the keyboard its
// caret there
function sliced(book, owner, at, byHand) {
  const { el } = owner;
  if (!byHand) owner.caret(at);
  openGap(el, at, {
    keyboard: !byHand,
    text: () => el.value ?? el.textContent,
    put: owner.put,
    read: lines => readWords(lines, body => notebookRequest('/api/book/read', body)),
    failed: err =>
      owner.page &&
      said(book, owner.page, `Your handwriting wasn’t read: ${err?.status ? err.message : 'HQ couldn’t be reached'}.`),
  });
}
