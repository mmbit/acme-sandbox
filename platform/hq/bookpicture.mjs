// node platform/hq/book-check.mjs --stories 'the shared picture' [--webkit] [--shots dir]
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Mirrors } from '../../shared/watchalong/mirror.ts';
import { playwright } from '../../shared/browser/browser.mjs';
import { playLine } from './bookcall.mjs';
import { inputs } from './bookhands.mjs';
import { minimiseCall } from './bookcallview.mjs';
import { MINI, UPRIGHT, until, middleOf, bookOpen } from './bookkit.mjs';

const COORDINATOR = new URL('../coordinator/', import.meta.url);
const sharp = createRequire(COORDINATOR)('sharp');
export function pictureStories(c) {
  return Object.fromEntries(
    [MINI, UPRIGHT].flatMap(viewport => [
      [
        `the shared picture shows the call tile and only the remaining ink at ${viewport.width} × ${viewport.height}`,
        browser => callPicture(browser, c, viewport),
      ],
      [
        `the shared picture shows review mode before and after sharing starts at ${viewport.width} × ${viewport.height}`,
        browser => reviewPicture(browser, c, viewport),
      ],
    ]),
  );
}

export async function recording(browser, c, viewport, { hasTouch = true } = {}) {
  const context = await c.hqIn(browser, viewport, {
    notebooks: {},
    hasTouch,
    deviceScaleFactor: 1,
  });
  const { events, notes } = await recordRoutes(context, c);
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  process.env.CHROMIUM_PATH ??= playwright().chromium.executablePath();
  const mirrors = new Mirrors(new URL('node_modules/@rrweb/replay/dist/', COORDINATOR), async ({ url }) => {
    if (!url.startsWith(c.base + '/')) return null;
    const response = await fetch(url);
    return response.ok
      ? { type: response.headers.get('content-type'), body: Buffer.from(await response.arrayBuffer()) }
      : null;
  });
  return {
    context,
    page,
    events,
    notes,
    errors,
    mirrors,
    fed: 0,
    viewport,
    c,
    hand: await inputs(browser, page),
    done: async () => {
      await mirrors.closeAll();
      await context.close();
    },
  };
}

async function recordRoutes(context, c) {
  const events = [],
    notes = [];
  await context.route('**/shared/watchalong/vendor/rrweb-record.js', async r =>
    r.fulfill({
      contentType: 'text/javascript',
      body: await readFile(new URL('node_modules/@rrweb/record/dist/record.js', COORDINATOR)),
    }),
  );
  await context.route(`${c.base}/api/watchalong/start`, r =>
    r.fulfill({ json: { id: 1, events: `${c.base}/picture-events` } }),
  );
  await context.route(`${c.base}/picture-events`, r => {
    events.push(...r.request().postDataJSON().events);
    return r.fulfill({ json: { seen: true } });
  });
  await context.route(`${c.base}/api/book/note`, r => {
    notes.push(r.request().postDataJSON());
    return r.fulfill({ json: { note: { id: notes.length, n: notes.length, page: notes.at(-1).page } } });
  });
  return { events, notes };
}

async function callPicture(browser, c, viewport) {
  const s = await recording(browser, c, viewport);
  const { page, hand } = s;
  const line = await playLine(s.context);
  try {
    await page.goto(`${c.base}/?intro=0&open=intercom&renderer=wire`);
    await page.waitForSelector('#loading.gone');
    await bookOpen(page, false);
    await page.locator('#call').tap();
    await page.waitForFunction(() => !document.querySelector('#call-screenshare')?.disabled);
    await page.locator('#call-screenshare').tap();
    await minimiseCall(page);
    await tilesInPicture(s);
    await crossesInPicture(s, line);
    await bookOpen(page, true);
    await hand.pan([
      [viewport.width * 0.75, viewport.height * 0.65],
      [viewport.width * 0.8, viewport.height * 0.6],
    ]);
    await bookOpen(page, false);
    await hand.stroke('pen', [middleOf(await page.locator('.cb-face').boundingBox())]);
    await page.waitForSelector('#call-layer', { state: 'visible' });
    await page.locator('#call-end').tap();
    await page.waitForSelector('#call-layer', { state: 'detached' });

    // The call stops recording at hang-up. A cleared note was already recorded while sharing.
    c.noErrorsIn(s.errors);
  } finally {
    await s.done();
  }
}

async function tilesInPicture(s) {
  const { page, hand, viewport } = s;
  for (const type of ['pen', 'touch']) {
    const face = middleOf(await page.locator('.cb-face').boundingBox());
    await hand.stroke(type, [face, [viewport.width * (type === 'pen' ? 0.7 : 0.6), viewport.height * 0.3]]);
    await page.waitForTimeout(600);
    const tile = await page.locator('.callbubble').boundingBox();
    const picture = await screen(s, `tile-${type}`);
    await matches(page, picture.bytes, tile, 'the call tile is in the shared picture');
    assert.equal(await page.locator('#call-layer').isVisible(), false, 'a drag leaves the call small');
  }
}

async function crossesInPicture(s, line) {
  const { page, hand } = s;
  const first = { x: 90, y: 520, width: 100, height: 80 };
  const second = { x: 230, y: 650, width: 100, height: 80 };
  await cross(hand, first);
  await until(() => s.notes.length === 1, 'the first cross filed');
  await cross(hand, second);
  await until(() => s.notes.length === 2, 'the second cross filed');
  const both = await screen(s, 'both');
  await sameInk(s, both.bytes, first, true);
  await sameInk(s, both.bytes, second, true);
  line.send({ type: 'note', id: 1, state: 'done' });
  await page.waitForTimeout(200);
  const remaining = await screen(s, 'remaining');
  await sameInk(s, remaining.bytes, first, false);
  await sameInk(s, remaining.bytes, second, true);
  const past = await s.mirrors.at(s.events, s.events.at(-1).timestamp, shot(s), () => true);
  await sameInk(s, past.bytes, first, false);
  await sameInk(s, past.bytes, second, true);
  line.send({ type: 'note', id: 2, state: 'done' });
  await page.waitForTimeout(200);
  const cleared = await screen(s, 'cleared');
  await sameInk(s, cleared.bytes, second, false);
}

export async function cross(hand, b) {
  const x = b.x + 12,
    y = b.y + 12,
    right = b.x + b.width - 12,
    bottom = b.y + b.height - 12;
  await hand.stroke('pen', [
    [x, y],
    [right, bottom],
  ]);
  await hand.stroke('pen', [
    [right, y],
    [x, bottom],
  ]);
}

const shot = s => ({ long: Math.max(s.viewport.width, s.viewport.height), png: true });
export async function screen(s, name) {
  await s.page.evaluate(async name => {
    const { record } = await import('/shared/watchalong/vendor/rrweb-record.js');
    record.addCustomEvent('check', { name });
  }, name);
  await until(() => s.events.some(e => e.type === 5 && e.data.tag === 'check' && e.data.payload.name === name), name);
  if (!s.fed) await s.mirrors.open(1, s.events, () => true);
  else s.mirrors.feed(1, s.events.slice(s.fed));
  s.fed = s.events.length;
  const picture = await s.mirrors.now(1, shot(s));
  assert.ok(picture, 'the agent has a picture');
  if (s.c.shots) await writeFile(`${s.c.shots}/picture-${s.viewport.width}-${name}.png`, picture.bytes);
  await s.c.shot(`board-${s.viewport.width}-${name}`, s.page);
  return picture;
}

export async function sameInk(s, picture, box, expected) {
  const board = await s.page.screenshot();
  const counts = await Promise.all([board, picture].map(bytes => redIn(bytes, box)));
  assert.equal(counts[0] > 100, expected, `the board's ink is ${expected ? 'present' : 'gone'}`);
  assert.equal(counts[1] > 100, expected, `the shared ink matches the board (${counts})`);
}

async function redIn(bytes, box) {
  const pixels = await sharp(bytes).extract(rect(box)).removeAlpha().raw().toBuffer();
  let red = 0;
  for (let i = 0; i < pixels.length; i += 3)
    if (pixels[i] > 130 && pixels[i] > pixels[i + 1] * 1.5 && pixels[i] > pixels[i + 2] * 1.3) red++;
  return red;
}
const rect = b => ({
  left: Math.ceil(b.x),
  top: Math.ceil(b.y),
  width: Math.floor(b.width),
  height: Math.floor(b.height),
});
export async function matches(page, picture, box, why, tolerance = 0.15) {
  const board = await page.screenshot();
  const [a, b] = await Promise.all(
    [board, picture].map(bytes => sharp(bytes).extract(rect(box)).removeAlpha().raw().toBuffer()),
  );
  let off = 0;
  for (let i = 0; i < a.length; i += 3) if (Math.max(...[0, 1, 2].map(c => Math.abs(a[i + c] - b[i + c]))) > 65) off++;
  assert.ok(off / (a.length / 3) < tolerance, `${why}: ${((off / (a.length / 3)) * 100).toFixed(1)}% differs`);
}

async function reviewPicture(browser, c, viewport) {
  for (const before of [true, false]) {
    const s = await recording(browser, c, viewport);
    try {
      const root = await preview(s, before);
      await root.locator('.sheet:not([hidden])').waitFor();
      await root.locator('textarea').fill('The preview needs a change');
      await snapshotMatches(s.page);
      await privateThumbnail(root);
      const picture = await screen(s, `postit-${before}`);
      assert.ok(JSON.stringify(s.events).includes('The preview needs a change'), 'the post-it words are recorded');
      assert.ok(!JSON.stringify(s.events).includes('Private fixture person'), 'private words stay out of UI labels');
      await reviewMatches(s, picture, root);
      await s.context.route('**/__review/notes', r =>
        r.fulfill({ status: 429, json: { error: 'This note cannot be saved yet' } }),
      );
      await root.locator('.send').tap();
      await root.locator('.msg').filter({ hasText: 'This note cannot be saved yet' }).waitFor();
      const refused = await screen(s, `refusal-${before}`);
      assert.ok(JSON.stringify(s.events).includes('This note cannot be saved yet'), 'the refusal words are recorded');
      await matches(s.page, refused.bytes, await root.locator('.msg').boundingBox(), 'the refusal is in the picture');
      c.noErrorsIn(s.errors);
    } finally {
      await s.done();
    }
  }
}

async function preview(s, before) {
  await s.context.route(`${s.c.base}/picture-preview`, r =>
    r.fulfill({
      contentType: 'text/html',
      body:
        '<!doctype html><body style="margin:0;background:#cad8ed"><h1>Preview</h1><button>Try this</button>' +
        '<div data-private style="position:absolute;left:300px;top:120px;width:50px;height:40px;background:#00ff00">Private fixture person</div>' +
        (before ? '<script src="/__review/review.js"></script>' : ''),
    }),
  );
  await s.page.goto(`${s.c.base}/picture-preview`);
  if (before) await s.page.waitForSelector('review-mode', { state: 'attached' });
  await s.page.evaluate(async () => {
    const { watch } = await import('/shared/watchalong/watchalong.js');
    window.watching = watch({ url: '/picture-events', typed: 'shown' });
  });
  if (!before) await s.page.addScriptTag({ url: '/__review/review.js' });
  const root = s.page.locator('review-mode');
  await root.locator('.fab').waitFor({ timeout: 5000 });
  await s.page.touchscreen.tap(...middleOf(await root.locator('.fab').boundingBox()));
  await s.hand.stroke('pen', [
    [110, 150],
    [210, 200],
    [140, 240],
  ]);
  return root;
}

async function reviewMatches(s, picture, root) {
  for (const selector of ['.sheet', 'textarea', '.polaroid']) {
    const tolerance = selector === '.sheet' ? 0.15 : 0.02;
    await matches(
      s.page,
      picture.bytes,
      await root.locator(selector).boundingBox(),
      `${selector} matches the board`,
      tolerance,
    );
  }
}

async function privateThumbnail(root) {
  const pixel = await root.locator('.polaroid .img img').evaluate(async image => {
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const g = canvas.getContext('2d');
    g.drawImage(image, 0, 0);
    const k = canvas.width / innerWidth;
    return [...g.getImageData(310 * k, 130 * k, 1, 1).data].slice(0, 3);
  });
  assert.ok(
    pixel.every(c => Math.abs(c - 140) < 5),
    'the thumbnail retains private-content masks',
  );
}

// Opening the tool's root must not turn its hidden full-screen ink canvases into privacy masks.
async function snapshotMatches(page) {
  const matches = await page.evaluate(async () => {
    const { snapshot } = await import('/__review/snapshot.js');
    const r = { host: document.querySelector('review-mode'), popups: [] };
    const plain = await snapshot(r);
    const masked = await snapshot(r, { masked: true });
    if (!plain || !masked) return false;
    const pixel = (picture, x, y) => [
      ...picture.c.getContext('2d').getImageData(x * picture.k, y * picture.k, 1, 1).data,
    ];
    return (
      String(pixel(plain, 400, 300)) === String(pixel(masked, 400, 300)) &&
      String(pixel(masked, 310, 130)) === '140,140,140,255'
    );
  });
  assert.ok(matches, 'the note picture masks the private box and leaves the rest of the page visible');
}
