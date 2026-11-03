// The book's controls put over its paper (bookui.js islands(): the tools on the right, the bar along the foot), Undo
// and Redo at the bar's left, by the thumb, for a finger drawing (the keys do the same, and Safari hands the Pencil's
// squeeze no Undo a page can take), and Close notebook last in its dots menu.
import { button, island, islands, lineIcon, MOD } from './bookui.js';
import { word } from './bookscope.js';

const ICONS = {
  undo: lineIcon('<path d="M9 7H4V2"/><path d="M4.5 7A8 8 0 1 1 6 17"/>'),
  // (Undo's arrow turned the other way.)
  redo: lineIcon('<path d="M15 7h5V2"/><path d="M19.5 7A8 8 0 1 0 18 17"/>'),
  // (a book shut, its spine at its left)
  close: lineIcon('<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 3v18"/>'),
};

// node: the controls' element. on: { undo, redo, close }, the book's (book.js)
export function mountRail(node, on) {
  node.append(islands());
  const undo = button({ icon: ICONS.undo, label: word('undo'), keys: `${MOD}+Z`, onClick: on.undo }),
    redo = button({ icon: ICONS.redo, label: word('redo'), keys: `${MOD}+Shift+Z`, onClick: on.redo }),
    close = button({ icon: ICONS.close, label: word('closeNotebook'), onClick: on.close });
  undo.classList.add('bk-undo');
  redo.classList.add('bk-redo');
  close.classList.add('bk-close');
  island('history').append(undo, redo);
  island('book').append(close);
}
