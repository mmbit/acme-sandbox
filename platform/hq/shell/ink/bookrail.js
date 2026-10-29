// The book's rail: Undo and Redo on their island over the paper's right edge (islands floating over the paper:
// bookui.js). (the faces, their planes and the invited people's books gone with the sheets, pages now sent whole:
import { button, island, islands, MOD } from './bookui.js';
import { word } from './bookscope.js';

const ICONS = {
  undo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7H4V2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M4.5 7A8 8 0 1 1 6 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  // (Undo's arrow turned the other way.)
  redo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 7h5V2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M19.5 7A8 8 0 1 0 18 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

// node: the rail's element. on: { undo, redo }, the book's (book.js.: the lip is bookhandle.js's)
export function mountRail(node, on) {
  // (the controls float as small islands over the paper's right edge, one style for all: bookui.js.)
  node.append(islands());
  const book = island('book'),
    undo = button({ icon: ICONS.undo, label: word('Undo'), keys: `${MOD}+Z`, onClick: on.undo }),
    redo = button({ icon: ICONS.redo, label: word('Redo'), keys: `${MOD}+Shift+Z`, onClick: on.redo });
  undo.classList.add('bk-undo');
  redo.classList.add('bk-redo');
  book.append(undo, redo);
}
