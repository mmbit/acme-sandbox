// The book's controls put over its paper (bookui.js islands(): the tools on the right, the bar along the foot), Undo
// and Redo at the bar's left, by the thumb, for a finger drawing (the keys do the same, and Safari hands the Pencil's
// squeeze no Undo a page can take), and Close notebook last in its dots menu.
import { button, island, islands, MOD } from './bookui.js';
import { icon } from '../icons.js';
import { word } from './bookscope.js';

// node: the controls' element. on: { undo, redo, close }, the book's (book.js)
export function mountRail(node, on) {
  node.append(islands());
  const undo = button({ icon: icon('undo'), label: word('undo'), keys: `${MOD}+Z`, onClick: on.undo }),
    redo = button({ icon: icon('redo'), label: word('redo'), keys: `${MOD}+Shift+Z`, onClick: on.redo }),
    close = button({ icon: icon('book'), label: word('closeNotebook'), onClick: on.close });
  undo.classList.add('bk-undo');
  redo.classList.add('bk-redo');
  close.classList.add('bk-close');
  island('history').append(undo, redo);
  island('book').append(close);
}
