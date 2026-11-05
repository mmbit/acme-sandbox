// book-check.mjs's story of an agent's notes on a call's page: its drawing shown as a drawing (bookgroups.css
// .bk-photo[data-drawing]: lines straight on its post-it) and a screenshot as a picture taped on, and each note a unit
// of its own that no other covers, on a call's notes page (a design session's is the same), on an iPad mini upright and
// in landscape, a bigger iPad in landscape and a phone. Its shots show how they look.
import assert from 'node:assert/strict';
import { watchedPage } from './start.mjs';
import { mode } from './notespage.mjs';
import { MINI, UPRIGHT } from './kit.mjs';

// An iPad Air in landscape
const IPAD = { width: 1180, height: 820 },
  OPEN = ['open', 'spread'];
const PAGE = 9101,
  DRAWN = `${PAGE}-g-000000d1.png`,
  PHOTO = `${PAGE}-g-000000p1.png`;

// c: book-check's { hqIn, base, shot, noErrorsIn }, and its phone
export const notesDrawnStories = c => {
  const devices = { 'iPad mini upright': UPRIGHT, 'iPad mini landscape': MINI, 'iPad landscape': IPAD, phone: c.PHONE };
  const stories = {};
  for (const [device, viewport] of Object.entries(devices))
    stories[`a call's notes: an agent's drawing shown as a drawing, each note its own unit (call, ${device})`] =
      browser => drawnOwn(browser, c, viewport, device);
  return stories;
};

async function drawnOwn(browser, c, viewport, device) {
  const T = new Date().toISOString();
  const context = await c.hqIn(browser, viewport, { notebooks: seed(T) });
  const pictures = await picturesOf(context);
  const { page, errors } = await watchedPage(context);
  // (the seed's pictures, as the store would serve them)
  await page.route('**/api/notebooks/pictures?*', route => {
    const file = new URL(route.request().url()).searchParams.get('file');
    return pictures[file]
      ? route.fulfill({ status: 200, contentType: 'image/png', body: pictures[file] })
      : route.fallback();
  });
  try {
    await page.goto(`${c.base}/?intro=0&open=intercom`);
    await page.waitForSelector('#loading.gone');
    // (opened: beside HQ, or upright as a spread)
    if (!OPEN.includes(await mode(page))) {
      await page.focus('#book .bk-lip');
      await page.keyboard.press('Enter');
      await page.waitForFunction(open => open.includes(document.documentElement.dataset.book), OPEN);
    }
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('#book .bk-photo img')].filter(i => i.complete && i.naturalWidth).length === 2,
      null,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(600);
    await drawnAndTaped(page);
    await ownUnits(page);
    await c.shot(`book-notes-drawn-call-${device.replaceAll(' ', '-')}`, page);
    c.noErrorsIn(errors);
  } finally {
    await context.close();
  }
}

// The drawing shown as a drawing, the screenshot as a picture
async function drawnAndTaped(page) {
  const shown = await page.evaluate(() => ({
    drawn: document.querySelectorAll('#book .bk-photo[data-drawing]').length,
    taped: document.querySelectorAll('#book .bk-photo:not([data-drawing])').length,
  }));
  assert.deepEqual(shown, { drawn: 1, taped: 1 }, 'the drawing as a drawing, the screenshot as a picture');
}

// Each note a unit of its own, none of them over another
async function ownUnits(page) {
  const units = await page.evaluate(
    page =>
      [
        ...document.querySelector(`#book .bk-groups[data-page="${page}"]`).parentElement.querySelectorAll('.bk-unit'),
      ].map(el => {
        const r = el.getBoundingClientRect();
        return { g: el.dataset.unit, x0: r.left, y0: r.top, x1: r.right, y1: r.bottom };
      }),
    PAGE,
  );
  assert.equal(units.length, 5, 'each note a unit of its own');
  for (const [i, a] of units.entries())
    for (const b of units.slice(i + 1))
      assert.ok(
        b.x0 >= a.x1 || a.x0 >= b.x1 || b.y0 >= a.y1 || a.y0 >= b.y1,
        `notes #${a.g} and #${b.g} don't cover each other: ${JSON.stringify([a, b])}`,
      );
}

// A call's page with what an agent puts on it: a drawing (a mug, its lines on a clear ground), a note, a screenshot,
// and two notes more.
const seed = T => {
  const words = (id, text) => ({ id, page: PAGE, kind: 'note', by: 'juno', created: T, texts: typed(text) });
  const picture = (id, file, more) => ({
    id,
    page: PAGE,
    kind: 'scrap',
    by: 'juno',
    created: T,
    pictures: [{ file, x: 0, y: 0, w: 320, h: 200, tilt: 0, ...more }],
  });
  return {
    notebooks: [{ id: 1, kind: 'mine', name: 'My journal', created: T, updated: T }],
    pages: [
      {
        ...{ id: PAGE, notebook: 1, pos: 0, kind: 'call', label: 'Oefensessie', created: T, updated: T },
        ...{ w: 1200, h: 1600 },
      },
    ],
    groups: [
      picture(1, DRAWN, { drawing: true }),
      words(2, 'Ideeën tot nu toe: één belknop, de ontwerpsessie aan en uit'),
      picture(3, PHOTO),
      words(4, 'Meer ruimte tussen notities die niet bij elkaar horen'),
      words(5, 'Tik-toon alleen als Juno op iemand reageert'),
    ],
  };
};
const typed = text => [{ x: 12, y: 0, w: 296, text, color: '#1d1a2f' }];

// The two pictures, made in a page of their own: the drawing on a clear ground as drawing.ts makes it, the screenshot
// opaque. → { file: PNG bytes }
async function picturesOf(context) {
  const art = await context.newPage();
  try {
    await art.setContent(`<body style="margin:0">
<svg id="drawn" width="640" height="400" viewBox="0 0 640 400" style="display:block"><g fill="none" stroke="#000"
stroke-width="6" stroke-linecap="round"><rect x="200" y="120" width="180" height="200" rx="18"/>
<path d="M380 170 q70 0 70 50 t-70 50"/><path d="M250 100 q-15 -30 0 -60 M300 100 q-15 -30 0 -60"/></g></svg>
<div id="photo" style="width:640px;height:400px;background:linear-gradient(135deg,#fff,#c8e0ff)">HQ</div></body>`);
    return {
      [DRAWN]: await art.locator('#drawn').screenshot({ omitBackground: true }),
      [PHOTO]: await art.locator('#photo').screenshot(),
    };
  } finally {
    await art.close();
  }
}
