// The book in a native shell that draws the Apple Pencil itself (platform/ios: Pen.swift): its own ink over the paper,
// with none of a browser's lag. The shell is told where the paper is and the ink in use while the pen or the
// highlighter is picked on an open book; with any other tool, in the overview, folded or on a locked page, the Pencil
// is the page's as in a browser. Each stroke it drew comes back here and is played as the pen's own pointer events, so the book takes it
// exactly as one drawn on the page (a scratch-out, ink over words, a tap on a box of words, a step for Undo).
// In a browser there's no shell: bookpages.js never loads this.
import { isTap } from '/__review/tap.js';
import { shut } from './booksave.js';
import { boardScale, giveBack } from './bookgroupshow.js';

// the tools whose line the shell draws
const NATIVE = ['pen', 'highlighter'];
// (the book slides and turns by animations no event tells of: where the paper is, looked at this often)
const LOOK_MS = 250;
// (the played strokes' pointer ids, clear of a real pointer's)
const IDS = 9000;

// { pen: false }, or { pen: { tool, paper: [x, y, width, height], color, size, alpha } } in the page's px, each time it
// changes. The line is as wide as it lands: at the board's own zoom, which a zoom a slide lent gives way to as the
// Pencil touches. The shell calls window.shellPenDown(x, y) as the Pencil
// touches the paper, and window.shellPen(points) with each stroke once drawn.
export function mountNative(book) {
  let told = '';
  const tell = () => {
    const pen = penOf(book),
      said = JSON.stringify(pen);
    if (said === told) return;
    told = said;
    window.webkit.messageHandlers.shell.postMessage({ pen });
  };
  setInterval(() => document.hidden || tell(), LOOK_MS);
  // (a tool or its colour picked: at once, so the Pencil's next press is the new tool's)
  new MutationObserver(tell).observe(book.desk, { attributes: true, attributeFilter: ['data-tool', 'style'] });
  // (the Pencil on the paper: a zoom a slide lent is the board's again at once, about where it touched, as a browser's
  // press gives it back (bookgroupshow.js), so its whole stroke lands at the board's zoom). A Pencil on the tools over the paper leaves it lent, as a press there does in a browser.
  window.shellPenDown = (x, y) => book.desk.contains(document.elementFromPoint(x, y)) && giveBack(x, y);
  let played = 0;
  // (a stroke on the paper lands at the zoom it was drawn at. An app built from Xcode before its Pen.swift called
  // shellPenDown (README.md) gets the zoom back after its stroke instead)
  window.shellPen = points => {
    const [x, y] = points[0],
      target = document.elementFromPoint(x, y);
    return play(target, points, IDS + (played++ % 1000)).then(() => book.desk.contains(target) && giveBack(x, y));
  };
}

function penOf(book) {
  const tool = book.tools?.mode(),
    page = book.view()?.page;
  // (none on a locked page, where nothing draws (bookwrite.js): its line would land and go.)
  if (!NATIVE.includes(tool) || book.far() || book.desk.closest('[inert]') || (page && shut(page))) return false;
  const r = book.desk.getBoundingClientRect(),
    x = Math.max(0, r.left),
    y = Math.max(0, r.top),
    w = Math.min(innerWidth, r.right) - x,
    h = Math.min(innerHeight, r.bottom) - y;
  if (w < 1 || h < 1) return false;
  const { color, size, alpha = 1 } = book.tools.ink();
  return { tool, paper: [x, y, w, h].map(Math.round), color, size: Math.round(size * boardScale() * 100) / 100, alpha };
}

// A stroke the shell drew ([x, y, pressure, ms from its first point], in the page's px), played as a pen's pointer
// events to target, what's under its first point (on the paper, in view: always something), as a browser sends them: a
// tap is a click there too. Resolves once the page has painted what it made of it, for the shell's own line to go.
function play(target, points, pointerId) {
  const t0 = performance.now() - points.at(-1)[3];
  const send = (type, [clientX, clientY, pressure, t]) => {
    const lifted = type === 'pointerup',
      e = new PointerEvent(type, {
        pointerId,
        pointerType: 'pen',
        isPrimary: true,
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX,
        clientY,
        // (a lift says no pressure, as Safari's does)
        pressure: lifted ? 0 : pressure,
        button: type === 'pointermove' ? -1 : 0,
        buttons: lifted ? 0 : 1,
      });
    Object.defineProperty(e, 'timeStamp', { value: t0 + t });
    target.dispatchEvent(e);
    return e;
  };
  const down = send('pointerdown', points[0]);
  for (const p of points.slice(1)) send('pointermove', p);
  const up = send('pointerup', points.at(-1));
  const reach = Math.max(...points.map(([x, y]) => Math.hypot(x - points[0][0], y - points[0][1])));
  if (isTap(down, up, reach)) target.click();
  return new Promise(painted => requestAnimationFrame(() => requestAnimationFrame(painted)));
}
