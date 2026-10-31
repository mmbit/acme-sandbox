// book-check.mjs's story of things arriving on a Notebook page (shell/ink/bookarrive.js): a scrap from the store (an
// agent's, another screen's) and a picture pasted here each set down once, on the iPad mini upright (touch) and on a
// desktop. Each landing is held at its last frame and let go: the page then shows it where the copy ended, pixel for
// pixel but antialiasing, and only the copy showed it while it played. The board's own line, saved and read back,
// lands not at all, and nothing lands again.
import assert from 'node:assert/strict';
import { open } from './booknotebook.mjs';
import { pen } from './booknotebookscreen.mjs';
import { DESKTOP, UPRIGHT, until } from './bookkit.mjs';

// a picture of the seed's store (mock/notebook.json)
const SNIP = 'book-snip-1.svg';
// share of a landing's pixels that may differ from the page's drawing of it (antialiasing: by more than ROUGH of 255
// in a channel), and that must differ with the copy hidden, the thing itself held off the page meanwhile (by more than
// FINE: a white card on cream paper)
const SAME = 0.02,
  HELD = 0.2,
  ROUGH = 40,
  FINE = 4;

// c: book-check.mjs's hqIn, base, settled, settle, shot, noErrorsIn
export function arrivalStories(c) {
  return {
    'things arriving on a Notebook page: a scrap from the store and a picture pasted each land once, where the page draws them, on the iPad mini and a desktop':
      async browser => {
        await arrivals(browser, c, UPRIGHT, { hasTouch: true, folded: true });
        await arrivals(browser, c, DESKTOP, {});
      },
  };
}

async function arrivals(browser, c, viewport, more) {
  const size = `${viewport.width}x${viewport.height}`,
    { page, play, errors, done } = await open(browser, c, viewport, more);
  try {
    await watch(page);
    // (each on a new page: over the seed's ink, the page draws its ink over the picture once it's down)
    const fresh = await newPage(page, play, c),
      spot = await paperSpot(page);
    play.route('/api/notebooks/groups/create', {}, { page: fresh, pictures: [{ file: SNIP, ...spot, tilt: 2 }] });
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
  assert.ok(clip.x >= 0 && clip.y >= 0 && clip.x + clip.width <= page.viewportSize().width, `${what}: in view`);
  const ending = await page.screenshot({ clip });
  await page.evaluate(n => (window.__landings[n - 1].sheet.style.visibility = 'hidden'), n);
  const under = await page.screenshot({ clip });
  await c.shot(`arrival-${n}-${page.viewportSize().width}`, page);
  await page.evaluate(n => {
    const { sheet, animations } = window.__landings[n - 1];
    sheet.style.visibility = '';
    animations.forEach(a => a.finish());
  }, n);
  await until(() => page.evaluate(n => !window.__landings[n - 1].sheet.isConnected, n), `${what} down`);
  const after = await page.screenshot({ clip });
  const moved = await differ(page, ending, after, ROUGH),
    held = await differ(page, ending, under, FINE);
  assert.ok(moved < SAME, `${what}: ends where the page draws it (${(moved * 100).toFixed(1)}% of its pixels differ)`);
  assert.ok(held > HELD, `${what}: held off the page while it lands (${(held * 100).toFixed(1)}% differ)`);
  await page.waitForTimeout(1500);
  assert.equal(await landed(page), n, `${what}: lands once`);
}

// New page pressed: the page it makes in the store (its id)
async function newPage(page, play, c) {
  await page.locator('#book').getByRole('button', { name: 'New page', exact: true }).click();
  await page.waitForTimeout(c.settle);
  return play.route('/api/notebooks/pages', { notebook: 1 }).pages.at(-1).id;
}
// A spot on the page the paper shows, clear of the strip and the bar (page px)
const paperSpot = page =>
  page.evaluate(() => {
    const desk = document.querySelector('#book .bk-desk').getBoundingClientRect(),
      el = document.querySelector('#book .bk-world .bk-page:not([hidden])'),
      on = el.getBoundingClientRect(),
      k = on.width / el.offsetWidth,
      x = (desk.left + desk.width * 0.3 - on.left) / k,
      y = (desk.top + desk.height * 0.45 - on.top) / k;
    return { x: Math.round(x), y: Math.round(y), w: 240, h: 103 };
  });

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

// A line the board draws with the Pencil low on the paper, saved to the store (which tells the page, and it's read
// again)
async function ownLine(page, play, on) {
  const lines = () =>
      play.route('/api/notebooks/pages/groups', { page: on }).groups.reduce((n, g) => n + g.ink.length, 0),
    before = lines(),
    desk = await page.locator('#book .bk-desk').boundingBox(),
    x = Math.round(desk.x + desk.width * 0.3),
    y = Math.round(desk.y + desk.height * 0.75);
  await page.evaluate(() => document.activeElement?.blur());
  await pen(page, [
    [x, y],
    [x + 60, y + 20],
    [x + 120, y],
  ]);
  await until(() => lines() > before, "the board's line saved");
  await page.waitForTimeout(1500);
}

// The share of two screenshots' pixels (PNG) that differ by more than by in a channel
const differ = (page, a, b, by) =>
  page.evaluate(
    async ([a, b, by]) => {
      const pixels = async bytes => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' })),
          canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
          g = canvas.getContext('2d');
        g.drawImage(bitmap, 0, 0);
        return g.getImageData(0, 0, bitmap.width, bitmap.height).data;
      };
      const [x, y] = await Promise.all([pixels(a), pixels(b)]);
      let n = 0;
      for (let i = 0; i < x.length; i += 4)
        if (Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2])) > by) n++;
      return n / (x.length / 4);
    },
    [[...a], [...b], by],
  );
