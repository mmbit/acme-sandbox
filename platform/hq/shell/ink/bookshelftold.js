// The overview's words for a moment at its foot, with Undo when there's something to undo (bookshelf.js): beside the
// overview on the paper, so it never scrolls away. s: bookshelf.js's screens. (out of bookshelf.js)

// how long Undo stays offered
const UNDO_MS = 6000;

// Its place, once: under the overview, on the paper
export function mountTold(s) {
  Object.assign(s.undo, {
    className: 'bk-told',
    hidden: true,
    innerHTML: '<span></span><button type="button">Undo</button>',
  });
  s.undo.setAttribute('role', 'status');
  s.far.after(s.undo);
  s.undo.querySelector('button').addEventListener('click', () => {
    const undo = s.undoing;
    told(s, null);
    undo?.();
  });
}
// Words at the overview's foot for a moment, with Undo when there's something to undo (null: put away)
export function told(s, words, undo = null) {
  clearTimeout(s.undoTimer);
  s.undoing = undo;
  s.undo.hidden = !words;
  if (!words) return;
  s.undo.querySelector('span').textContent = words;
  s.undo.querySelector('button').hidden = !undo;
  s.undoTimer = setTimeout(() => told(s, null), UNDO_MS);
}
