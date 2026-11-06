// The book's controls put over its paper (bookui.js islands(): the tools on the right, the bar along the foot), and on
// the bar Undo, for a guest's send taken back (bookcontrols.js). The book closes by its pull tab (bookhandle.js) or a
// swipe from the page's left edge, never from the page's menu.
import { button, island, islands, MOD } from './bookui.js';
import { icon } from '../icons.js';
import { word } from './bookscope.js';

// node: the controls' element. on: { undo }, the book's (book.js)
export function mountRail(node, on) {
  node.append(islands());
  const undo = button({ icon: icon('undo'), label: word('undo'), keys: `${MOD}+Z`, onClick: on.undo });
  undo.classList.add('bk-undo');
  island('history').append(undo);
}
