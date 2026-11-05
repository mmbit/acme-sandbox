// The book's controls put over its paper (bookui.js islands(): the tools on the right, the bar along the foot), Undo
// and Redo a pill left of the bar, by the thumb, for a finger drawing (the keys do the same, and Safari hands the
// Pencil's squeeze no Undo a page can take). The book closes by its pull tab (bookhandle.js) or a swipe from the page's
// left edge, never from the page's menu.
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
  placePill(node);
}
// Undo and Redo's pill left of the bar, or above its left end where the room left of the bar can't hold it
// (bookstrip.css): measured, since the bar is as wide as its keys (a guest's Send) and the screen and the tools leave
// it. In layout widths, never the screen's boxes, which the book's swing scales. Watched on the foot, the bar and the
// pill, which is no size while it's gone.
function placePill(node) {
  const foot = node.querySelector('.bk-foot'),
    bar = foot.querySelector('.bk-bar'),
    pill = foot.querySelector('.bk-undo-pill');
  const place = () => {
    const { paddingLeft, paddingRight } = getComputedStyle(foot),
      // (the bar centred in the foot's padding: bookstrip.css .bk-foot)
      room = (foot.clientWidth - parseFloat(paddingLeft) - parseFloat(paddingRight) - bar.offsetWidth) / 2,
      gap = parseFloat(getComputedStyle(pill).getPropertyValue('--bk-pill-gap'));
    pill.toggleAttribute('data-above', room < pill.offsetWidth + gap);
  };
  const watch = new ResizeObserver(place);
  for (const el of [foot, bar, pill]) watch.observe(el);
}
