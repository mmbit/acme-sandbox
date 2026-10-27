// book-check.mjs's stories of the book's body (shell/book.js, booklayout.js, bookhandle.js, bookcover.js, bookflip.js):
// the folded book's handle, nudging no one, pulled in with the book on it, and a mark landing in it showing its snip; the book let go anywhere staying there,
// with HQ at a phone's width beside it, and folding when let go too narrow to draw on; the table's quiet checkerboard
// where the book moves off it; the open showing the cover first, then the page; a page turned forward and back by one
// turn played either way. Each asserts what the board sees: boxes, frames, words.
import assert from 'node:assert/strict';

const MINI = { width: 1133, height: 744 };
// (longer than a flick's reading of the last moves, booklayout.js: let go where it is)
const HOLD_MS = 200;

// c: book-check.mjs's helpers: { hq(browser, viewport, options), shot(name, page), settled(page, mode), settle }
export function bodyStories(c) {
  return {
    "the book's body: pulled by its handle, the book comes with it and stays where it's let go": browser =>
      pulledIn(browser, c),
    "the book's body: a mark landing in the folded book shows its snip on the handle, and the tap opens the book":
      browser => landing(browser, c),
    "the book's body: the spine let go stays there, HQ a phone's width beside it; let go too narrow, it folds":
      browser => letGo(browser, c),
    "the book's body: the table where the book moves off it is a quiet checkerboard, not a flat fill": browser =>
      table(browser, c),
    "the book's body: opening shows the cover as the book comes in, then it swings open onto the page": browser =>
      opening(browser, c),
    "the book's body: a page turned forward and back is the one 3D turn, played either way": browser =>
      turning(browser, c),
  };
}

// ---- the stories

async function pulledIn(browser, c) {
  const { page, errors, done } = await atMini(browser, c);
  try {
    await putAway(page, c);
    const handle = page.locator('#book .bk-lip');
    await c.shot('book-body-handle', page);
    // pulled to 40% of the screen: the handle goes with the pointer, the book's spine just behind it, the cover on show
    const from = await handle.boundingBox(),
      x = from.x + from.width / 2,
      y = from.y + from.height / 2,
      to = MINI.width * 0.4 - from.width / 2,
      dx = to - x;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(to, y, { steps: 12 });
    await page.waitForTimeout(HOLD_MS);
    const held = await handle.boundingBox(),
      spine = await page.locator('#book [role=separator]').boundingBox();
    assert.ok(
      Math.abs(held.x - (from.x + dx)) <= 2,
      `the handle at ${held.x}, the pointer moved it ${dx} from ${from.x}`,
    );
    assert.ok(
      Math.abs(spine.x - (held.x + held.width)) <= 2,
      `the spine at ${spine.x}, the handle ends at ${held.x + held.width}`,
    );
    assert.ok(await coverShows(page), 'the cover shows as the book comes in');
    await c.shot('book-body-pulled', page);
    await page.mouse.up();
    await c.settled(page, 'open');
    const hqWidth = await page.evaluate(() => document.body.getBoundingClientRect().width);
    assert.ok(Math.abs(hqWidth - MINI.width * 0.4) <= 3, `let go at 40% of ${MINI.width}, HQ is ${hqWidth} px`);
    noErrors(errors);
  } finally {
    await done();
  }
}

async function landing(browser, c) {
  const { page, errors, done } = await atMini(browser, c);
  try {
    await putAway(page, c);
    // (as booklanding.js tells it once the ink has flown into the handle)
    await page.evaluate(snip => {
      const id = 1;
      document.dispatchEvent(new CustomEvent('book:landed', { detail: { id, page: null, snip } }));
    }, SNIP);
    const snip = page.locator('#book .bk-lip .bk-snip');
    await snip.waitFor({ timeout: 2000 });
    await page.waitForTimeout(400);
    const box = await snip.boundingBox();
    assert.ok(
      box && box.x >= 0 && box.x + box.width <= MINI.width,
      `the snip beside the handle: ${JSON.stringify(box)}`,
    );
    await c.shot('book-body-landed', page);
    await snip.waitFor({ state: 'detached', timeout: 5000 });
    await page.locator('#book .bk-lip').click();
    await c.settled(page, 'open');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.book), 'open');
    noErrors(errors);
  } finally {
    await done();
  }
}

async function letGo(browser, c) {
  const { page, errors, done } = await atMini(browser, c);
  try {
    // to 360 px of HQ, past the middle of the screen: it stays
    await dragSpine(page, 360);
    await c.settled(page, 'open');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.book), 'open');
    assert.ok(Math.abs((await hqWidth(page)) - 360) <= 2, `HQ is ${await hqWidth(page)} px, let go at 360`);
    await c.shot('book-body-phone-hq', page);
    // to 250 px of paper: too narrow to draw on, it folds
    await dragSpine(page, MINI.width - 12 - 250);
    await c.settled(page, 'folded');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.book), 'folded');
    assert.equal(await hqWidth(page), MINI.width);
    noErrors(errors);
  } finally {
    await done();
  }
}

async function table(browser, c) {
  const { page, errors, done } = await atMini(browser, c);
  try {
    const hq = await hqWidth(page),
      x = await spineX(page),
      y = 500;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 260, y, { steps: 12 });
    await page.waitForTimeout(HOLD_MS);
    // mid-drag, between HQ's page and the spine: two tones that alternate, not one flat fill
    const tones = await lightsIn(page, { x: hq + 30, y: 200, width: 150, height: 200 });
    await c.shot('book-body-table', page);
    await page.mouse.up();
    assert.ok(tones.size >= 2 && tones.spread <= 40, `the table's tones: ${JSON.stringify(tones)}`);
    noErrors(errors);
  } finally {
    await done();
  }
}

async function opening(browser, c) {
  const { page, errors, done } = await atMini(browser, c);
  try {
    await putAway(page, c);
    // every frame from the tap: where the spine is, whether the cover shows, and whether the book's laid out open
    const seen = page.evaluate(
      () =>
        new Promise(resolve => {
          const start = performance.now(),
            frames = [],
            spine = document.querySelector('#book [role=separator]'),
            cover = document.querySelector('#book .bk-cover'),
            frame = () => {
              frames.push({
                t: Math.round(performance.now() - start),
                spine: Math.round(spine.getBoundingClientRect().left),
                cover: !cover.hidden,
                open: document.documentElement.dataset.book === 'open',
              });
              if (performance.now() - start < 1400) requestAnimationFrame(frame);
              else resolve(frames);
            };
          requestAnimationFrame(frame);
        }),
    );
    await page.locator('#book .bk-lip').click();
    const frames = await seen,
      coming = frames.filter(f => f.spine < MINI.width && !f.open),
      shown = frames.filter(f => f.cover),
      landed = frames.find(f => f.open);
    assert.ok(coming.length >= 2, `the book coming in: ${JSON.stringify(frames.slice(0, 12))}`);
    assert.ok(
      coming.every(f => f.cover),
      `the page showed before the cover as the book came in: ${JSON.stringify(coming)}`,
    );
    assert.ok(landed && shown.at(-1).t > landed.t, 'the cover swings open once the book has landed');
    // (about half a second; headless frames under a busy machine come late)
    assert.ok(shown.at(-1).t < 1500, `the cover and leaves still turning at ${shown.at(-1).t} ms`);
    assert.ok(!frames.at(-1).cover && frames.at(-1).open, 'open on the page after');
    noErrors(errors);
  } finally {
    await done();
  }
}

async function turning(browser, c) {
  const { page, errors, done } = await atMini(browser, c);
  try {
    const back = await turn(page, 'The page before'),
      forward = await turn(page, 'The page after');
    for (const [way, t] of Object.entries({ back, forward }))
      assert.ok(t.frames >= 3, `turning ${way}, the leaf showed in ${t.frames} frames`);
    // one turn: the same frames, the same timing, played forward one way and backwards the other
    assert.deepEqual(back.keyframes, forward.keyframes);
    assert.deepEqual(
      { ...back.timing, direction: 'reverse' },
      { ...forward.timing, direction: 'reverse' },
      'the same timing both ways',
    );
    assert.deepEqual([forward.timing.direction, back.timing.direction], ['normal', 'reverse']);
    noErrors(errors);
  } finally {
    await done();
  }
}
// A page turned by the foot's arrow: the turning leaf's transforms as they're drawn, frame by frame, and its turn's
// keyframes and timing
async function turn(page, name) {
  const watched = page.evaluate(
    () =>
      new Promise(resolve => {
        const start = performance.now(),
          drawn = [];
        let turn = null;
        const frame = () => {
          const leaf = document.querySelector('#book .bk-turn-leaf'),
            spin = leaf?.getAnimations().find(a => a.effect.getKeyframes().some(k => k.transform));
          if (spin) {
            turn ??= {
              keyframes: spin.effect.getKeyframes().map(k => ({ offset: k.offset, transform: k.transform })),
              timing: (({ duration, easing, direction }) => ({ duration, easing, direction }))(spin.effect.getTiming()),
            };
            drawn.push(getComputedStyle(leaf).transform);
          }
          if (performance.now() - start < 1500) requestAnimationFrame(frame);
          else resolve({ ...turn, frames: new Set(drawn).size });
        };
        requestAnimationFrame(frame);
      }),
  );
  await page.locator('#book').getByRole('button', { name, exact: true }).click();
  const seen = await watched;
  assert.ok(seen.keyframes, `${name}: no leaf turned`);
  return seen;
}

// ---- helpers

// HQ on an iPad mini's landscape with a mouse, the book open
async function atMini(browser, c) {
  const opened = await c.hq(browser, MINI, { hasTouch: false, deviceScaleFactor: 1 });
  await c.settled(opened.page, 'open');
  return opened;
}
const spineX = async page => {
  const r = await page.locator('#book [role=separator]').boundingBox();
  return r.x + r.width / 2;
};
const hqWidth = page => page.evaluate(() => document.body.getBoundingClientRect().width);
// The spine dragged to x (its left edge), held there a moment and let go
async function dragSpine(page, x) {
  const from = await spineX(page);
  await page.mouse.move(from, 400);
  await page.mouse.down();
  await page.mouse.move(x + 6, 400, { steps: 12 });
  await page.waitForTimeout(HOLD_MS);
  await page.mouse.up();
}
// The book put away: its spine flicked right, to the screen's edge
async function putAway(page, c) {
  const x = await spineX(page);
  await page.mouse.move(x, 400);
  await page.mouse.down();
  await page.mouse.move(MINI.width - 10, 400, { steps: 3 });
  await page.mouse.up();
  await c.settled(page, 'folded');
}
const coverShows = page =>
  page.evaluate(() => {
    const cover = document.querySelector('#book .bk-cover');
    return !cover.hidden && cover.getBoundingClientRect().width > 100;
  });
// The lightnesses (0-255, rounded to 2) in a box on the screen: how many there are, and how far apart
async function lightsIn(page, clip) {
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
        seen = new Set();
      for (let i = 0; i < data.length; i += 4) seen.add(Math.round((data[i] + data[i + 1] + data[i + 2]) / 6) * 2);
      return { size: seen.size, spread: Math.max(...seen) - Math.min(...seen) };
    },
    `data:image/png;base64,${png.toString('base64')}`,
  );
}
const noErrors = errors => assert.deepEqual(errors, []);
// A snip: a small picture of HQ with a ring of red ink on it
const SNIP = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#e9e3f7"/><rect x="20" y="30" width="80" height="14" fill="#3a3148"/><ellipse cx="60" cy="37" rx="52" ry="22" fill="none" stroke="#ff5a5f" stroke-width="4"/></svg>',
)}`;
