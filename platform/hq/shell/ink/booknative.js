// The book in a native shell that draws the Apple Pencil itself (platform/ios: Pen.swift): its own ink over the paper,
// with none of a browser's lag. The shell is told where the paper is and the ink in use while the pen or the
// highlighter is picked on an open book; with any other tool, in the overview or folded, the Pencil is the page's as in
// a browser. Each stroke it drew comes back here and is played as the pen's own pointer events, so the book takes it
// exactly as one drawn on the page (a scratch-out, a line through words, a tap on a box of words, a step for Undo).
// In a browser there's no shell: bookpages.js never loads this.
import { isTap } from '/__review/tap.js';

// the tools whose line the shell draws
const NATIVE = ['pen', 'highlighter'];
// (the book slides and turns by animations no event tells of: where the paper is, looked at this often)
const LOOK_MS = 250;
// (the played strokes' pointer ids, clear of a real pointer's)
const IDS = 9000;

// { pen: false }, or { pen: { tool, paper: [x, y, width, height], color, size, alpha } } in the page's px, the line as
// wide as it's drawn at the page's zoom; each time it changes. The shell calls window.shellPen(points) with a stroke.
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
  let played = 0;
  window.shellPen = points => play(points, IDS + (played++ % 1000));
}

function penOf(book) {
  const tool = book.tools?.mode();
  if (!NATIVE.includes(tool) || book.far() || book.desk.closest('[inert]')) return false;
  const r = book.desk.getBoundingClientRect(),
    x = Math.max(0, r.left),
    y = Math.max(0, r.top),
    w = Math.min(innerWidth, r.right) - x,
    h = Math.min(innerHeight, r.bottom) - y;
  if (w < 1 || h < 1) return false;
  const { color, size, alpha = 1 } = book.tools.ink();
  return { tool, paper: [x, y, w, h].map(Math.round), color, size: Math.round(size * book.scale * 100) / 100, alpha };
}

// A stroke the shell drew ([x, y, pressure, ms from its first point], in the page's px), played as a pen's pointer
// events to what's under its first point (on the paper, in view: always something), as a browser sends them: a tap is
// a click there too. Resolves once the page has painted what it made of it, for the shell's own line to go.
function play(points, pointerId) {
  const target = document.elementFromPoint(points[0][0], points[0][1]);
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
