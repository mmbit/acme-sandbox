// HQ-OS › Notebook (once the Sketchbook): the board's sketches, to draw anything and hand it to the CEO, on the computer's screen
// (sketchshelf.js draws the shelf, sketchpage.js one sketch). An HQ app on the interface a company's own apps use
// (template/kits/README.md), the platform's own, on every computer.
// (the shelf moved to sketchshelf.js, shared with an invited person's book; this
// is the board's book)
import { stylesheet } from '../../util.js';
import { toast } from '../toast.js';
import { ceoName, openIntercom } from '../desk.js';
import { loadSketches, loadSketch, sketchAction, uploadScrap } from './sketchdata.js';
import { shelf, back } from './sketchshelf.js';

export const app = {
  name: 'Notebook', // (the board's name for it, once Sketchbook)
  what: 'Draw anything and send it to the CEO',
  icon: 'app-sketchbook',
  group: 'work',
};

// Each time the computer (re)draws it: on opening and every 15 s (not while a name is being typed)
export async function draw(el, hq) {
  el.closest('.device')?.classList.add('sk-wide');
  await stylesheet('shell/ink/sketchbook.css');
  await shelf(el, boardBook(hq));
}
export { back };

// The board's book, from HQ's own routes (sketchdata.js), its sends opening the intercom
const boardBook = hq => ({
  dev: hq.dev,
  list: () => loadSketches(hq.dev),
  load: id => loadSketch(hq.dev, id),
  act: (what, body) => sketchAction(hq.dev, what, body),
  upload: (id, blob) => uploadScrap(hq.dev, id, blob),
  to: ceoName(),
  sent: openIntercom,
  toast,
  ago: hq.ago,
});
