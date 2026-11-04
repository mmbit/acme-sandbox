// The book's controls put over its paper (bookui.js islands(): the tools on the right, the bar along the foot), Undo
// and Redo at the bar's left, by the thumb, for a finger drawing (the keys do the same, and Safari hands the Pencil's
// squeeze no Undo a page can take). The book closes by its pull tab (bookhandle.js) or a swipe from the page's left
// edge, never from the page's menu.
import { button, island, islands, MOD } from './bookui.js';
import { icon } from '../icons.js';
import { word } from './bookscope.js';

// node: the controls' element. on: { undo, redo }, the book's (book.js)
export function mountRail(node, on) {
  node.append(islands());
  const undo = button({ icon: icon('undo'), label: word('undo'), keys: `${MOD}+Z`, onClick: on.undo }),
    redo = button({ icon: icon('redo'), label: word('redo'), keys: `${MOD}+Shift+Z`, onClick: on.redo });
  undo.classList.add('bk-undo');
  redo.classList.add('bk-redo');
  island('history').append(undo, redo);
}
