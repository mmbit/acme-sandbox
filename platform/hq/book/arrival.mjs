// book-check.mjs's story of things arriving on a Notebook page (shell/ink/bookarrive.js): a scrap from the store (an
// agent's, another screen's) and a picture pasted here each set down once, on the iPad mini upright (touch) and on a
// desktop. Each landing is held at its last frame and let go: the page then draws it where the copy ended, its edges
// within a px or two (each engine smooths a turned picture its own way, so their pixels never match exactly), and only
// the copy showed it while it played. The board's own line on the scrap opened, saved and read back, lands not at all,
// and nothing lands again.
import assert from 'node:assert/strict';
import { open } from './notebook.mjs';
import { DESKTOP, UPRIGHT, closeScrap, openScrap, until } from './kit.mjs';
import { hands } from './hands.mjs';
import { press } from './bar.mjs';

// a picture of the seed's store (mock/notebook.json)
const SNIP = 'book-snip-1.svg';
// how far (px) the landing's last frame may end from the page's drawing of it, edge by edge; a thing's pixels are those
// differing from the paper under it by more than ROUGH of 255 in a channel. The share of pixels that must differ with
// the copy hidden, the thing itself held off the page meanwhile (by more than FINE: a white card on cream paper).
const OFF_PX = 2,
  HELD = 0.2,
  ROUGH = 40,
  FINE = 4;
// where the store's scrap has its picture (its own px)
const SPOT = { x: 0, y: 0, w: 240, h: 103 };

// c: book-check.mjs's hqIn, base, settled, settle, shot, noErrorsIn
export function arrivalStories(c) {
  return {
    'things arriving on a Notebook page: a scrap from the store and a picture pasted each land once, where the page draws them, on the iPad mini and a desktop':
      async browser => {
        for (const look of LOOKS(browser)) await arrivals(browser, c, UPRIGHT, { hasTouch: true, folded: true, look });
        await arrivals(browser, c, DESKTOP, {});
      },
  };
}

// HQ's three looks: Brownstone, Slate and Holo (Slate in Chromium only: Linux's headless WebKit can't start it, film.mjs)
export const LOOKS = browser => [
  '',
  ...(browser.browserType().name() === 'chromium' ? ['&renderer=wire'] : []),
  '&renderer=holo',
];

async function arrivals(browser, c, viewport, more) {
  const size = `${viewport.width}x${viewport.height}${more.look ?? ''}`,
    { page, play, errors, done } = await open(browser, c, viewport, more);
  try {
    await watch(page);
    // (each on a new page: over the seed's ink, the page draws its ink over the picture once it's down)
    // (a scrap's picture in its own px, at its top-left as the store makes one: the grid places the scrap)
    const fresh = await newPage(page, play, c);
    play.route('/api/notebooks/groups/create', {}, { page: fresh, pictures: [{ file: SNIP, ...SPOT, tilt: 2 }] });
    await landsOnce(page, c, 1, `a scrap from the store (${size})`);
    await ownLine(page, play, fresh);
    assert.equal(await landed(page), 1, `the board's own line never lands, and nothing lands again (${size})`);
    await newPage(page, play, c);
    await pastePicture(page);
    await landsOnce(page, c, 2, `a picture pasted (${size})`);
    c.noErrorsIn(errors);
  } finally {
    await done();
  }
}

// Every landing as it starts held at its last frame, till the story lets it go
const watch = page =>
  page.evaluate(() => {
    window.__landings = [];
    new MutationObserver(records => {
      for (const node of records.flatMap(r => [...r.addedNodes]))
        if (node.classList?.contains('bk-fx-land')) {
          const animations = node.getAnimations({ subtree: true });
          for (const a of animations) {
            a.pause();
            a.currentTime = a.effect.getComputedTiming().endTime - 1;
          }
          window.__landings.push({ sheet: node, animations });
        }
    }).observe(document.getElementById('book'), { childList: true, subtree: true });
  });
const landed = page => page.evaluate(() => window.__landings.length);

// The n-th landing: at its end the copy where the page draws the thing once it's gone, and the thing not drawn
// under it meanwhile; then it lands no more
async function landsOnce(page, c, n, what) {
  await until(async () => (await landed(page)) >= n, `${what} landing`);
  assert.equal(await landed(page), n, `${what}: one landing`);
  const clip = await page.evaluate(n => {
    const r = window.__landings[n - 1].sheet.getBoundingClientRect();
    return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  }, n);
  assert.ok(
    clip.x >= 0 && clip.y >= 0 && clip.x + clip.width <= page.viewportSize().width,
    `${what}: in view (${JSON.stringify(clip)})`,
  );
  // (the page settled round the held copy first: what a paste picks, Select's frame, shows in both shots)
  await page.waitForTimeout(c.settle);
  const ending = await page.screenshot({ clip });
  await page.evaluate(n => (window.__landings[n - 1].sheet.style.visibility = 'hidden'), n);
  const under = await page.screenshot({ clip });
  const look = new URL(page.url()).searchParams.get('renderer') ?? 'brownstone';
  await c.shot(`arrival-${n}-${page.viewportSize().width}-${look}`, page);
  await page.evaluate(n => {
    const { sheet, animations } = window.__landings[n - 1];
    sheet.style.visibility = '';
    animations.forEach(a => a.finish());
  }, n);
  await until(() => page.evaluate(n => !window.__landings[n - 1].sheet.isConnected, n), `${what} down`);
  const after = await page.screenshot({ clip });
  const [flown, drawn] = await Promise.all([ending, after].map(shot => extent(page, shot, under, ROUGH))),
    off = Math.max(...['x0', 'y0', 'x1', 'y1'].map(e => Math.abs(flown[e] - drawn[e]))),
    held = await differ(page, ending, under, FINE);
  assert.ok(
    off <= OFF_PX,
    `${what}: ends where the page draws it (${JSON.stringify(flown)}, drawn ${JSON.stringify(drawn)})`,
  );
  assert.ok(held > HELD, `${what}: held off the page while it lands (${(held * 100).toFixed(1)}% differ)`);
  await page.waitForTimeout(1500);
  assert.equal(await landed(page), n, `${what}: lands once`);
}

// New page pressed: the page it makes in the store (its id), wherever the journal puts it among the seed's
async function newPage(page, play, c) {
  const ids = () => play.route('/api/notebooks/pages', { notebook: 1 }).pages.map(p => p.id),
    before = ids();
  await press(page, 'New page');
  await page.waitForTimeout(c.settle);
  return ids().find(id => !before.includes(id));
}

// Cmd/Ctrl+V of a picture made here
const pastePicture = page =>
  page.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 240, height: 160 }),
      g = canvas.getContext('2d');
    g.fillStyle = '#d2582a';
    g.fillRect(0, 0, 240, 160);
    const png = await new Promise(done => canvas.toBlob(done, 'image/png')),
      clipboard = new DataTransfer();
    clipboard.items.add(new File([png], 'pasted.png', { type: 'image/png' }));
    document.body.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }),
    );
  });

// A line the board draws with the Pencil low on the scrap that arrived, opened, saved to the store (which tells the
// page, and it's read again), and the scrap put back
async function ownLine(page, play, on) {
  const { groups } = play.route('/api/notebooks/pages/groups', { page: on }),
    lines = () => play.route('/api/notebooks/pages/groups', { page: on }).groups.reduce((n, g) => n + g.ink.length, 0),
    before = lines(),
    { pen } = await hands(page);
  await page.evaluate(() => document.activeElement?.blur());
  const { sheet } = await openScrap(page, pen, groups.at(-1).id),
    x = Math.round(sheet.x + sheet.width * 0.3),
    y = Math.round(sheet.y + sheet.height * 0.75);
  await pen.stroke([
    [x, y],
    [x + 60, y + 20],
    [x + 120, y],
  ]);
  await until(() => lines() > before, "the board's line saved");
  await closeScrap(page, pen);
  await page.waitForTimeout(1500);
}

// Two screenshots' pixels (PNG) compared: the share of them that differ by more than by in a channel, and the box
// those pixels make.
const compared = (page, a, b, by) =>
  page.evaluate(
    async ([a, b, by]) => {
      const pixels = async bytes => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' })),
          canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
          g = canvas.getContext('2d');
        g.drawImage(bitmap, 0, 0);
        return { data: g.getImageData(0, 0, bitmap.width, bitmap.height).data, w: bitmap.width };
      };
      const [{ data: x, w }, { data: y }] = await Promise.all([pixels(a), pixels(b)]),
        box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      let n = 0;
      for (let i = 0; i < x.length; i += 4) {
        if (Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2])) <= by)
          continue;
        const [px, py] = [(i / 4) % w, Math.floor(i / 4 / w)];
        n++;
        Object.assign(box, {
          ...{ x0: Math.min(box.x0, px), y0: Math.min(box.y0, py) },
          ...{ x1: Math.max(box.x1, px + 1), y1: Math.max(box.y1, py + 1) },
        });
      }
      return { share: n / (x.length / 4), box };
    },
    [[...a], [...b], by],
  );
// The share of two screenshots' pixels that differ by more than by in a channel
const differ = async (page, a, b, by) => (await compared(page, a, b, by)).share;
// What a screenshot shows over the paper under it (a shot of that): the box of its pixels differing from it by more
// than by
const extent = async (page, shot, under, by) => (await compared(page, shot, under, by)).box;
