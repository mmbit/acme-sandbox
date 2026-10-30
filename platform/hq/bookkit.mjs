// What book-check.mjs's story files share: the screens they play on, a wait, the Pencil, and review mode's parts.

export const DESKTOP = { width: 1440, height: 900 },
  // an iPad mini in landscape
  MINI = { width: 1133, height: 744 };

// What read gives (awaited) once it's something, looked at every tenth of a second; what says what was awaited, or is
// called as it fails for words with what was seen. (long enough by default for a loaded worker, where the page's timers
// come seconds late: its 600 ms save took over 6 s)
export async function until(read, what, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) {
    const v = await read();
    if (v) return v;
  }
  throw new Error(`not ${typeof what === 'function' ? what() : what}`);
}

// Whether a box on the screen ({ x, y, width, height }) lies clear of every one of the book's islands
export const islandsClearOf = (page, box) =>
  page.evaluate(
    r =>
      [...document.querySelectorAll('#book .bk-island')].every(i => {
        const b = i.getBoundingClientRect();
        return !b.width || b.right <= r.x || b.left >= r.x + r.width || b.bottom <= r.y || b.top >= r.y + r.height;
      }),
    box,
  );
// The pixels in a box of the screen, each [r, g, b], row by row: its screenshot read back in the page
export async function pixelsIn(page, clip) {
  const png = await page.screenshot({ clip });
  return page.evaluate(
    async src => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const cv = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height }),
        g = cv.getContext('2d');
      g.drawImage(img, 0, 0);
      const { data } = g.getImageData(0, 0, cv.width, cv.height),
        pixels = [];
      for (let i = 0; i < data.length; i += 4) pixels.push([data[i], data[i + 1], data[i + 2]]);
      return pixels;
    },
    `data:image/png;base64,${png.toString('base64')}`,
  );
}

// A pointer pressed at the first point and moved along the rest, as Safari hands the Pencil over (type 'touch': a
// finger), and let go at the last unless lift is false. Held, it's moved on along(more points) and let go by up(), or
// in the page by window.__lift() (to see the very frame of the lift). on: a page or a frame.
export async function pressAlong(on, points, { lift = true, type = 'pen' } = {}) {
  await on.evaluate(sendPointer, { points, press: true, lift, type });
  return {
    along: more => on.evaluate(sendPointer, { points: more, press: false, lift: false, type }),
    up: () => on.evaluate(() => window.__lift()),
  };
}
// (in the page) Every event goes to what was under the press, inside review mode's shadow root too, as the page's
// pointer capture sends a real pointer's: a made-up one can't be captured. Points are filled in to no more than STEP_PX
// apart, as a Pencil reports them, its pressure rising and falling along the line and none at the lift.
function sendPointer({ points, press, lift, type }) {
  const STEP_PX = 8;
  const deepest = ([x, y]) => {
    let under = document.elementFromPoint(x, y) ?? document.body;
    for (let inner; (inner = under.shadowRoot?.elementFromPoint(x, y)) && inner !== under;) under = inner;
    return under;
  };
  if (press) {
    const held = { under: deepest(points[0]), last: points[0], moves: 0 };
    held.send = (kind, [x, y], pressure) =>
      held.under.dispatchEvent(
        new PointerEvent(kind, {
          ...{ pointerId: 7, pointerType: type, isPrimary: true, clientX: x, clientY: y, pressure },
          ...{ buttons: kind === 'pointerup' ? 0 : 1, bubbles: true, composed: true, cancelable: true },
        }),
      );
    window.__pressed = held;
    window.__lift = () => held.send('pointerup', held.last, 0);
    held.send('pointerdown', points[0], 0.4);
  }
  const held = window.__pressed;
  for (const p of press ? points.slice(1) : points) {
    const [x0, y0] = held.last,
      steps = Math.max(1, Math.ceil(Math.hypot(p[0] - x0, p[1] - y0) / STEP_PX));
    for (let i = 1; i <= steps; i++) {
      const at = [x0 + ((p[0] - x0) * i) / steps, y0 + ((p[1] - y0) * i) / steps];
      held.send('pointermove', at, 0.55 + 0.2 * Math.sin(held.moves++ / 6));
    }
    held.last = p;
  }
  if (lift) window.__lift();
}

// Chromium's own Pencil (cdp: the page's CDP session), whose events are trusted: their clicks and pointer capture are
// the browser's. Chromium only.
export function chromiumPen(cdp) {
  const send = (type, [x, y], down) =>
    cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: down || type === 'mouseReleased' ? 'left' : 'none',
      buttons: down ? 1 : 0,
      clickCount: 1,
      pointerType: 'pen',
      force: down ? 0.5 : 0,
    });
  const pen = {
    down: at => send('mousePressed', at, true),
    move: at => send('mouseMoved', at, true),
    up: at => send('mouseReleased', at, false),
    // down at the first point, along the rest, and up at the last
    stroke: async points => {
      await pen.down(points[0]);
      for (const p of points.slice(1)) await pen.move(p);
      await pen.up(points.at(-1));
    },
    tap: at => pen.stroke([at]),
  };
  return pen;
}

// A part of review mode's (CSS), inside its shadow root
export const ui = s => `review-mode >> css=${s}`;
