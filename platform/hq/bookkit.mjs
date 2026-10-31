// What book-check.mjs's story files share: the screens they play on, a wait, the Pencil and fingers, the iPad mini and
// the microphone's stand-in, review mode's parts and a preview in HQ's viewer.
import { fulfilPart } from '../../shared/review/parts.mjs';

export const DESKTOP = { width: 1440, height: 900 },
  // an iPad mini in landscape, and held upright
  MINI = { width: 1133, height: 744 },
  UPRIGHT = { width: MINI.height, height: MINI.width };
// how long a story waits to be sure something didn't happen (the page is saved this soon after a change), and what the
// stand-in microphone hears
export const QUIET_MS = 1200,
  HEARD = 'order the blue mugs';

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

// The book at rest in a mode, its swing over and laid out, and HQ's page shown again: lifted from shut, the book is
// 'folded' all the while it swings, so its mode alone says nothing; landed or shut, the swing keeps HQ's page hidden a
// few frames longer while it lays itself out (bookswing.js settleIn). However long the engine takes to draw the swing:
// headless WebKit's frames come slowly under HQ's scene, a few a second while HQ's page blurs. (book-check's and
// viewer-check's one wait for it.)
export const bookAtRest = (page, mode) =>
  page.waitForFunction(
    m =>
      document.documentElement.dataset.book === m &&
      !document.querySelector('#book.bk-swinging') &&
      getComputedStyle(document.body).visibility !== 'hidden',
    mode,
  );

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
// in the page by window.__lift() (to see the very frame of the lift). on: a page or a frame. doubleTap: a tap at the
// first point just before, in the same go, as a double tap's
export async function pressAlong(on, points, { lift = true, type = 'pen', doubleTap = false } = {}) {
  await on.evaluate(sendPointer, { points, press: true, lift, type, doubleTap });
  return {
    along: more => on.evaluate(sendPointer, { points: more, press: false, lift: false, type }),
    up: () => on.evaluate(() => window.__lift()),
  };
}
// (in the page) Every event goes to what was under the press, inside review mode's shadow root too, as the page's
// pointer capture sends a real pointer's: a made-up one can't be captured. Points are filled in to no more than STEP_PX
// apart, as a Pencil reports them, its pressure rising and falling along the line and none at the lift.
function sendPointer({ points, press, lift, type, doubleTap }) {
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
    if (doubleTap) {
      held.send('pointerdown', points[0], 0.4);
      held.send('pointerup', points[0], 0);
    }
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
  // (timestamp: when the hand did it, in s since 1970, else as it's sent)
  const send = (type, [x, y], down, timestamp) =>
    cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: down || type === 'mouseReleased' ? 'left' : 'none',
      buttons: down ? 1 : 0,
      clickCount: 1,
      pointerType: 'pen',
      force: down ? 0.5 : 0,
      ...(timestamp && { timestamp }),
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
    // A double tap pressed on, let go by up(): a 60 ms tap and the press 120 ms after its lift, in the times the page
    // reads (tap.js, bookinput.js) however late a loaded worker hands them on
    doubleTap: async at => {
      const t = Date.now() / 1000;
      await send('mousePressed', at, true, t);
      await send('mouseReleased', at, false, t + 0.06);
      await send('mousePressed', at, true, t + 0.18);
    },
  };
  return pen;
}
// Fingers (cdp: the page's CDP session, Chromium's trusted touch events): down at points, moved to others in steps,
// lifted
export function touchOf(cdp) {
  let last = [];
  const points = all => all.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 }));
  const t = {
    down: async at => {
      last = at;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(at) });
    },
    move: async (to, steps = 12) => {
      const from = last;
      for (let i = 1; i <= steps; i++) {
        const now = from.map(([x, y], k) => [x + ((to[k][0] - x) * i) / steps, y + ((to[k][1] - y) * i) / steps]);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(now) });
      }
      last = to;
    },
    up: () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
    stroke: async (from, to) => {
      await t.down(from);
      await t.move(to);
      await t.up();
    },
  };
  return t;
}
// A box's middle on the screen (a locator's boundingBox()).
export const middleOf = b => [b.x + b.width / 2, b.y + b.height / 2];

// The iPad mini as a touch screen with a pen, in Chromium (its own touch and pen events, trusted), the book open:
// upright (viewport UPRIGHT) it starts folded, and its lip opens it as the spread over HQ; more: the context's own
// options
export async function mini(browser, c, { viewport = MINI, ...more } = {}) {
  // (at 1x, so a screenshot's px are the screen's: colourIn)
  const context = await c.hqIn(browser, viewport, { hasTouch: true, deviceScaleFactor: 1, ...more });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await heard(page);
  await page.goto(`${c.base}/?intro=0`);
  if (viewport.width > viewport.height) {
    await page.waitForSelector('#book .bk-desk', { timeout: 30_000 });
    await c.settled(page, 'open');
  } else {
    await c.settled(page, 'folded');
    await page.evaluate(() => document.querySelector('#book .bk-lip').click());
    await c.settled(page, 'spread');
  }
  const cdp = await context.newCDPSession(page);
  return { page, pen: chromiumPen(cdp), touch: touchOf(cdp), errors, done: () => context.close() };
}
// The listening slip once it shows the stand-in microphone's words
export const wordsHeard = page =>
  until(async () => (await page.locator('#book .bk-voice').textContent()).includes(HEARD), 'the words heard');
// The microphone's stand-in: the recording module answered with one that hears at once, and its words; dictate.js runs
// for real on it (seconds).
export async function heard(page) {
  await page.route('**/shell/voice.js', r =>
    r.fulfill({
      contentType: 'text/javascript',
      body: `export const MAX_SECONDS = 1200, TRANSCRIBER = true, canRecord = true;
export function record({ onSegment } = {}) {
  const s = { ready: Promise.resolve(), level: () => 0.4, seconds: () => 1, cancel() {} };
  setTimeout(() => onSegment?.(new Blob(['piece'], { type: 'audio/wav' })), 100);
  s.stop = async () => new Blob(['clip'], { type: 'audio/webm' });
  return s;
}`,
    }),
  );
  // (and allowed already)
  await page.route('**/__review/micallowed.js', r =>
    r.fulfill({
      contentType: 'text/javascript',
      body: 'export const micAllowed = () => true, micBlocked = () => false, gotStream = () => {};',
    }),
  );
  await page.route('**/api/voice**', r => r.fulfill({ json: { text: HEARD } }));
  await page.addInitScript(() => {
    if (navigator.mediaDevices)
      navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'audioinput', deviceId: 'mic', label: '' }];
  });
}

// A part of review mode's (CSS), inside its shadow root
export const ui = s => `review-mode >> css=${s}`;
// HQ's pin turned on or off for this device, as Settings › Pin on HQ does (pinsetting.js keeps it in localStorage
// hq.pin and tells review mode): a story that isn't about the setting starts with the pin this way
export const pinOn = (page, on = true) =>
  page.evaluate(on => {
    localStorage.setItem('hq.pin', JSON.stringify(on));
    dispatchEvent(new CustomEvent('review:summon', { detail: on }));
  }, on);

// The next crumple (bookpaper.js) as it starts: whether it plays on a picture of what was deleted, and, with it held
// and stepped through its length, how far its middle goes sideways and how far down (px).
export const crumpled = page =>
  page.evaluate(
    () =>
      new Promise(done =>
        new MutationObserver((_, watching) => {
          const scrap = document.querySelector('#book .bk-fx-scrap');
          if (!scrap) return;
          watching.disconnect();
          const [ball] = scrap.getAnimations(),
            middle = () => {
              const r = scrap.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            };
          ball.pause();
          const length = ball.effect.getComputedTiming().duration;
          ball.currentTime = 0;
          const start = middle();
          let aside = 0,
            down = 0,
            shown = null; // (its opacity once it's well on its way down)
          for (let t = 0; t <= length; t += length / 80) {
            ball.currentTime = t;
            const now = middle();
            aside = Math.max(aside, Math.abs(now.x - start.x));
            down = Math.max(down, now.y - start.y);
            if (down > 40) shown ??= +getComputedStyle(scrap).opacity;
          }
          ball.play();
          done({ picture: !!scrap.querySelector('canvas'), aside, down, shown });
        }).observe(document.body, { childList: true, subtree: true }),
      ),
  );

// ---- a preview in HQ's viewer, review mode running in its frame
export const PREVIEW = 'https://scrap.preview.test';
const PREVIEW_PAGE = `<!doctype html><meta name="viewport" content="width=device-width"><title>Basket</title>
<body style="margin: 0; font: 16px system-ui, sans-serif">
<h1 style="margin: 24px">Your basket</h1>
<p style="margin: 24px; max-width: 30em">Two jars of plum jam, gift-wrapped, at the pick-up point by Friday.</p>
<script src="/__review/review.js"></script>`;
// The preview at PREVIEW served to context, each note posted from it kept in c.posts (c.reviewJs: review mode's script)
export async function previewServed(c, context) {
  await context.route(/\/api\/preview\/link$/, r => r.fulfill({ json: { url: r.request().postDataJSON().url } }));
  await context.route(`${PREVIEW}/**`, r => {
    const path = new URL(r.request().url()).pathname;
    if (fulfilPart(r, path, c.reviewJs)) return;
    // the board's note: the coordinator makes it a scrap on My journal's current page (bookreview.ts)
    if (path === '/__review/notes' && r.request().method() === 'POST') {
      const body = r.request().postDataJSON();
      c.posts.push({ path, body });
      const { v, url, el, view, ink } = body.element ?? {},
        g = context.notebook.route(
          '/api/notebooks/groups/scrap',
          {},
          {
            anchor: { v, url, el, view, ink },
            words: body.note,
            said: body.said === 'spoken' ? 'spoken' : 'typed',
            snip: body.shot,
            owner: 'juno',
          },
        );
      return r.fulfill({ json: { ok: true, id: g.id, page: g.page, owner: 'juno', name: 'Juno' } });
    }
    if (path.startsWith('/__review/')) return r.fulfill({ json: { show: false } });
    return r.fulfill({ contentType: 'text/html', body: PREVIEW_PAGE });
  });
}
