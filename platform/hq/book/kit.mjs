// What book-check.mjs's story files share: the screens they play on, a wait, the Shelf opened, the Pencil and fingers,
// the iPad mini, the microphone's stand-in and review mode's parts.
import assert from 'node:assert/strict';
import { until as untilShown } from '../../../shared/browser/browser.mjs';
import { en } from '../shell/ink/notebookwordsen.js';
import { filled } from '../shell/ink/notebookwords.js';

// (the microphone's stand-in, micstandin.mjs)
export { HEARD, heard, wordsHeard } from './micstandin.mjs';

export const DESKTOP = { width: 1440, height: 900 },
  // an iPad mini in landscape, and held upright
  MINI = { width: 1133, height: 744 },
  UPRIGHT = { width: MINI.height, height: MINI.width };
// The label of the overview's key on the book's rail (bookcontrols.js).
export const OVERVIEW = en.allPages;
// A word of the book's by its key, as it says it in English with its {places} filled (notebookwords.js): a copy edit
// there changes no story
export const say = (key, places) => filled(en[key], places);
// HQ's Shelf key, More opened first where it's folded behind it (Wire's phone row)
export async function shelfKey(page) {
  const key = page.locator('#btn-shelf');
  if (!(await key.isVisible())) await page.locator('#btn-more').click();
  return key;
}
// HQ in a look (its renderer), its Shelf key pressed: My shelf in its own window, read and at rest
export async function openShelf(page, c, renderer = 'wire') {
  await page.goto(`${c.base}/?intro=0&renderer=${renderer}`);
  await untilShown(page, '#loading.gone');
  await (await shelfKey(page)).click();
  const shelf = page.getByRole('dialog', { name: 'The Shelf' });
  await shelf.locator('.bk-book').first().waitFor();
  await shelfAtRest(page);
  await page.waitForTimeout(c.settle);
  assert.equal(await shelf.locator('.bk-shelf-title').textContent(), 'My shelf');
  return shelf;
}
// The Shelf's window risen, its things moved or arrived
export const shelfAtRest = page =>
  page.waitForFunction(() =>
    [...document.querySelectorAll('#book .bk-shelf-window')].every(d => !d.getAnimations({ subtree: true }).length),
  );
// The cog's label on the rail, in the words the board's book shows
export const PREFERENCES = en.preferences;
// how long a story waits to be sure something didn't happen (the page is saved this soon after a change)
export const QUIET_MS = 1200;
// a tap or a wait on the shared machine under load: taps time out at 30 s there, on main too
export const LOADED_MS = 90_000;

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
// headless WebKit's frames come slowly under HQ's scene, a few a second while HQ's page blurs. (The one wait for it
// in book-check, viewer-check and profile-covered.)
export const bookAtRest = (page, mode) =>
  page.waitForFunction(
    m =>
      document.documentElement.dataset.book === m &&
      !document.querySelector('#book.bk-swinging') &&
      getComputedStyle(document.body).visibility !== 'hidden',
    mode,
  );

// Open or fold the Notebook and wait until HQ is visible again.
export async function bookOpen(page, open, mouse = false) {
  const closed = await page.evaluate(() => ['folded', 'shut'].includes(document.documentElement.dataset.book));
  if (closed === open) {
    const lip = page.locator('#book .bk-lip');
    if (mouse) await lip.click();
    else await lip.tap();
  }
  await page.waitForFunction(
    open => !['folded', 'shut'].includes(document.documentElement.dataset.book) === open,
    open,
  );
  const mode = await page.evaluate(() => document.documentElement.dataset.book);
  await bookAtRest(page, mode);
}

// The pixels in a box of the screen, read from its screenshot (decoded by the browser): { data (RGBA), w, h }
export async function shotPixels(page, clip) {
  const png = await page.screenshot({ clip });
  const { b64, w, h } = await page.evaluate(
    async src => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const cv = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height }),
        g = cv.getContext('2d');
      g.drawImage(img, 0, 0);
      const data = g.getImageData(0, 0, cv.width, cv.height).data;
      let bin = '';
      for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return { b64: btoa(bin), w: cv.width, h: cv.height };
    },
    `data:image/png;base64,${png.toString('base64')}`,
  );
  return { data: Buffer.from(b64, 'base64'), w, h };
}
// ...each [r, g, b], row by row
export async function pixelsIn(page, clip) {
  const { data } = await shotPixels(page, clip),
    pixels = [];
  for (let i = 0; i < data.length; i += 4) pixels.push([data[i], data[i + 1], data[i + 2]]);
  return pixels;
}

// A story played at every size (sizes: name → size), the failures told together
export const atEverySize = (sizes, play) => async browser => {
  const failed = [];
  for (const [name, size] of Object.entries(sizes)) await play(browser, name, size).catch(e => failed.push(e.message));
  assert.deepEqual(failed, [], failed.join('\n'));
};

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

// Whether the book's page is the whole screen (data-whole on #book, book.js), its bookmarks folded at the left edge
export const whole = page => page.evaluate(() => document.querySelector('#book').hasAttribute('data-whole'));
// A chapter's bookmark picked (press(locator): a tap or a click, a click unless given). Where the page is the whole
// screen they lie folded at its left edge: a press on one's icon brings them out first, unless a pull already did,
// and the pick folds them away again.
export async function toChapter(page, chapter, press = loc => loc.click({ timeout: LOADED_MS })) {
  const tab = page.locator(`#book .bk-marks [data-chapter=${chapter}]`),
    out = page.locator('#book .bk-marks[data-out]');
  if (!(await whole(page))) return press(tab);
  if (!(await out.count())) await press(tab.locator('.bk-mk-icon'));
  await out.waitFor({ timeout: LOADED_MS });
  await press(tab);
  await out.waitFor({ state: 'detached', timeout: LOADED_MS });
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

// The next crumple (bookpaper.js) as it starts: whether it plays on a picture of what was deleted (drawn, or a page's
// tile in the overview), and, with it held and stepped through its length, how far its middle goes sideways, how far
// up and how far down (px), how far below the screen's foot it ends (px), its opacity once it's well on its way down,
// and its length (ms). Watched for on the whole document: the open book can sit outside body.
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
            up = 0,
            down = 0,
            shown = null;
          for (let t = 0; t <= length; t += length / 80) {
            ball.currentTime = t;
            const now = middle();
            aside = Math.max(aside, Math.abs(now.x - start.x));
            up = Math.max(up, start.y - now.y);
            down = Math.max(down, now.y - start.y);
            // (once it has begun to fall: one balled up at the screen's foot falls only its own size out of sight)
            if (down > 12) shown ??= +getComputedStyle(scrap).opacity;
          }
          ball.currentTime = length;
          const below = middle().y - innerHeight;
          ball.play();
          done({ picture: !!scrap.querySelector('canvas, .bk-tile-paper'), aside, up, down, below, shown, length });
        }).observe(document.documentElement, { childList: true, subtree: true }),
      ),
  );
// That crumpled()'s answer is what was deleted, balled up and fallen straight down past the screen's foot, never
// aside or up, still shown as it falls (what: whose fall, for the messages; the Ink README, The book's frame)
export const fellAway = ({ picture, aside, up, below, shown }, what) => {
  const px = n => Math.round(n * 10) / 10;
  assert.ok(
    picture && aside < 2 && up < 2 && below > 0,
    `${what}: crumpled and fallen straight down past the screen's foot (${px(aside)} aside, ${px(up)} up, ${px(below)} below it)`,
  );
  assert.ok(shown > 0.9, `${what}: still shown as it falls (${shown})`);
};

// This device's pen used before, as the board's iPad has it: a finger then moves the page while the pen writes
export const penPans = page =>
  page.evaluate(() => localStorage.setItem('ink.prefs', JSON.stringify({ penSeen: true, penPans: true })));
// How many strokes the store keeps on a call's notes page (notespage.mjs callSeed): what the page saved
export const strokes = page =>
  page
    .context()
    .notebook.route('/api/notebooks/pages/groups', { page: 9101 })
    .groups.reduce((n, g) => n + g.ink.length, 0);

// (each function below runs in the page, with page.evaluate, so it names what it reads itself.)
// A note on the screen by its unit id
export function unitOf(g) {
  const r = document.querySelector(`#book .bk-unit[data-unit="${g}"]`).getBoundingClientRect();
  return { g, x: r.left, y: r.top, w: r.width, h: r.height };
}
// How many inked pixels the shown page's canvases have in a box on the screen
export function inkAt(box) {
  let n = 0;
  for (const cv of document.querySelectorAll('#book .bk-page:not([hidden]) canvas.bk-ink')) {
    const r = cv.getBoundingClientRect(),
      k = cv.width / r.width,
      [x0, y0] = [Math.max(box.x, r.left), Math.max(box.y, r.top)],
      [x1, y1] = [Math.min(box.x + box.w, r.right), Math.min(box.y + box.h, r.bottom)];
    if (x1 - x0 < 1 || y1 - y0 < 1) continue;
    const { data } = cv
      .getContext('2d')
      .getImageData(
        Math.floor((x0 - r.left) * k),
        Math.floor((y0 - r.top) * k),
        Math.ceil((x1 - x0) * k),
        Math.ceil((y1 - y0) * k),
      );
    for (let i = 3; i < data.length; i += 4) if (data[i] > 128) n++;
  }
  return n;
}
