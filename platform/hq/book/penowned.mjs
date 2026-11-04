// book-check.mjs's story of the Notebook's pen (shared/review/pentouch.js ownsPen, shell/ink/book.js, bookdesk.css
// .bk-wet), held like an iPad mini both ways with the Pencil (hands.mjs: Chromium's trusted pen, Safari's in WebKit),
// on a call and off one: every tool and every colour on its card picked with a Pencil's tap (one that slides a few px,
// as a real one does) is picked, and nothing of HQ's pen is drawn on the book, no note made. A line drawn over a note's
// picture shows over it while the pen is down, as it lies once lifted. Run with --webkit for the same in the iPad's
// engine.
// With Settings' Call marks in the Notebook on (shell/ink/bookcallmarks.js): alone, the same. On a call, the tools,
// their cards and the overview's menu on the paper are still the book's, picked with the pen, and the line over the
// picture is the call's, a note for its agent shown over the picture while it's drawn, nothing in the notebook's ink.
import assert from 'node:assert/strict';
import { MINI, UPRIGHT, middleOf, strokes, until } from './kit.mjs';
import { hands } from './hands.mjs';
import { watchedPage, restsOpen } from './start.mjs';
import { callSeed, fillCall } from './notespage.mjs';
import { playLine } from './call.mjs';
import { minimiseCall } from './callview.mjs';
import { nothingDrawn } from './ink.mjs';
import { tool } from './pen.mjs';

// c: book-check.mjs's { hqIn, base, shot, settled, noErrorsIn }
export const penOwnedStories = c =>
  Object.fromEntries(
    [
      [MINI, 'landscape'],
      [UPRIGHT, 'portrait'],
    ].flatMap(([viewport, held]) =>
      [
        {
          title: `the Notebook's pen picks every tool and draws over pictures off a call, call marks on (${held})`,
          call: false,
          marks: true,
        },
        {
          title: `the Notebook's pen picks every tool and draws over pictures on a call (${held})`,
          call: true,
          marks: false,
        },
        {
          title: `call marks on: the call's pen marks the Notebook's paper, its tools and menus the book's (${held})`,
          call: true,
          marks: true,
        },
      ].map(({ title, call, marks }) => [
        title,
        browser =>
          owned(browser, c, viewport, `${held}-${call ? 'call' : 'alone'}${marks ? '-marks' : ''}`, { call, marks }),
      ]),
    ),
  );

async function owned(browser, c, viewport, name, { call, marks }) {
  const context = await c.hqIn(browser, viewport, {
    hasTouch: true,
    deviceScaleFactor: 1,
    notebooks: callSeed(new Date().toISOString()),
  });
  const line = call ? await playLine(context) : null;
  // (each note review mode's pen makes, counted, and the call's. Alone, Call marks in the Notebook as the story has it)
  await context.addInitScript(marks => {
    window.__notes = 0;
    window.__callNotes = 0;
    document.addEventListener('pencil:note', e => (window.__notes++, e.detail?.call && window.__callNotes++));
    localStorage.setItem('hq.bookCallMarks', JSON.stringify(marks));
  }, marks && !call);
  const { page, errors } = await watchedPage(context);
  const { pen } = await hands(page),
    tap = box => slidTap(pen, box, browser.browserType().name() === 'webkit' ? 8 : 12);
  try {
    await page.goto(`${c.base}/?intro=0&open=intercom`);
    await page.waitForSelector('#loading.gone');
    // (the call picked up first: held upright, the open book covers HQ's call key)
    if (line) {
      await page.evaluate(() => document.querySelector('#call').click());
      await page.waitForFunction(() => !document.querySelector('#call-screenshare')?.disabled);
      await minimiseCall(page);
      if (marks) await callMarks(page, name);
    }
    await restsOpen(page, c, viewport);
    // (the agent's scraps, each with its picture: on a call, on the call's notes page the book turned to)
    await fillCall(page, context.notebook, viewport);
    await page.waitForFunction(() => document.querySelectorAll('#book .bk-words').length >= 8, null, {
      timeout: 30_000,
    });
    await page.waitForTimeout(1500);
    await penChecks(page, pen, tap, name, c, call && marks);
    if (line) await page.locator('.cb-hangup').tap();
    c.noErrorsIn(errors);
  } catch (error) {
    await c.shot(`pen-owned-${name}-failed`, page);
    throw error;
  } finally {
    await context.close();
  }
}

// The book's tools and their cards picked with the pen, and a line drawn over a picture. With the call's marks
// (theCalls) the overview's menu picked too, and the line the call's
async function penChecks(page, pen, tap, name, c, theCalls) {
  await everyTool(page, tap, name, c);
  assert.equal(await page.evaluate(() => window.__notes), 0, `${name}: no note of HQ's pen made on the book`);
  await nothingDrawn(page, `${name}: the book's tools`);
  if (theCalls) {
    await overviewMenu(page, tap, name);
    assert.equal(await page.evaluate(() => window.__notes), 0, `${name}: no note of HQ's pen made on the menu`);
    await nothingDrawn(page, `${name}: the overview's menu`);
  }
  const kept = strokes(page);
  await overPictures(page, pen, name, c);
  if (theCalls) {
    await until(() => page.evaluate(() => window.__callNotes > 0), `${name}: the line a note for the call`);
    assert.equal(strokes(page), kept, `${name}: nothing of the call's line in the notebook's ink`);
  } else assert.equal(await page.evaluate(() => window.__notes), 0, `${name}: no note of HQ's pen made on the paper`);
}
// Settings › This device › Call marks in the Notebook switched on as the board taps it on a call, and Settings closed:
// the paper the call's pen's
async function callMarks(page, name) {
  await page.evaluate(() => import('/shell/desk.js').then(m => m.openComputer('settings')));
  const on = page.locator('#tool [data-switch="sys:bookcallmarks"]');
  await on.click();
  await page.waitForSelector('#tool [data-switch="sys:bookcallmarks"][aria-checked="true"]');
  await page.click('#tool [data-close]');
  assert.ok(
    await page.evaluate(() => document.querySelector('#book .bk-paper').matches('[data-takes-ink]:not([data-no-ink])')),
    `${name}: the paper the call's pen's`,
  );
}
// A Pencil's tap as a hand makes one: down, sliding reach px across the key, and up. 12 px past a tap's 10 px (tap.js).
// In WebKit 8: a slid tap's click there is Safari's own tap's, whose reach Apple doesn't give, and hands.mjs's stand-in
// clicks within 10 px
async function slidTap(pen, box, reach) {
  const [x, y] = middleOf(box);
  for (const [i, d] of [-2, -1, 0, 1, 2].entries())
    await pen[i ? 'move' : 'down']([x + (d * reach) / 4, y + (d * reach) / 12]);
  await pen.up([x + reach / 2, y + reach / 6]);
}
const tools = page => page.locator('#book [data-island=tools]').getByRole('button');
const palette = page => page.locator('#book .bk-palette');

// Every tool on the tools' island, then every choice on its card (the tool tapped again opens it), each tapped with the
// pen and seen pressed
async function everyTool(page, tap, name, c) {
  const names = await tools(page).evaluateAll(bs => bs.map(b => b.getAttribute('aria-label')).filter(Boolean));
  assert.ok(names.length >= 3, `${name}: the tools' island has its tools (${names})`);
  for (const key of names) {
    const b = page.locator('#book [data-island=tools]').getByRole('button', { name: key, exact: true });
    if (!(await b.isVisible())) continue;
    if ((await b.getAttribute('aria-pressed')) !== 'true') await tap(await b.boundingBox());
    if ((await b.getAttribute('aria-pressed')) === null) continue; // (Undo and Redo: no tool in hand)
    await until(async () => (await b.getAttribute('aria-pressed')) === 'true', `${name}: ${key} in hand`);
    await tap(await b.boundingBox());
    if (!(await palette(page).isVisible())) continue;
    const choices = await palette(page)
      .getByRole('menuitemradio')
      .evaluateAll(bs => bs.map(b => b.getAttribute('aria-label')));
    for (const choice of choices) {
      // (a choice of another tool, the marker's, changes the card: what's on it now)
      const item = palette(page).getByRole('menuitemradio', { name: choice, exact: true });
      if (!(await item.count())) continue;
      await tap(await item.boundingBox());
      await until(
        async () => (await item.count()) && (await item.getAttribute('aria-pressed')) === 'true',
        `${name}: ${key}'s ${choice} picked by the pen`,
      );
    }
    await c.shot(`pen-owned-${name}-${key.toLowerCase().replace(/\W+/g, '-')}-card`, page);
    if (await palette(page).isVisible()) await page.keyboard.press('Escape');
    console.log(`${name}: ${key} and its ${choices.length} choices picked with the pen`);
  }
}

// The overview (the bar's key) and its menu on the paper (its title line's dots, the book's though the paper is the
// call's: bookshelf.js), the menu's Archived pages picked, each with a tap that slides, and back to the page
async function overviewMenu(page, tap, name) {
  const key = page.locator('#book .bk-overview-key:visible').first();
  await tap(await key.boundingBox());
  // (not a page turn's picture of it)
  const onPaper = css => page.locator(`#book .bk-paper ${css}:not(.bk-turn-picture *)`);
  const dots = onPaper('.bk-far-more');
  await dots.waitFor();
  // (once the overview has come in: its title line still a moment)
  let box = null;
  await until(async () => {
    const was = box;
    box = await dots.boundingBox();
    await page.waitForTimeout(100);
    return was && box && was.x === box.x && was.y === box.y;
  }, `${name}: the overview in`);
  await tap(box);
  const row = onPaper('.bk-far-menu [data-opt="archived"]');
  await row.waitFor();
  await tap(await row.boundingBox());
  // (picked, the menu shuts and the archived pages show under the chapters)
  await onPaper('.bk-far-sub')
    .filter({ hasText: 'Archived pages' })
    .waitFor({ timeout: 5000 })
    .catch(() => assert.fail(`${name}: the overview's menu's Archived pages picked by the pen`));
  console.log(`${name}: the overview's menu on the paper picked with the pen`);
  await page.keyboard.press('Escape');
  await tap(await key.boundingBox());
  await dots.waitFor({ state: 'hidden' });
}

// The pen in hand, a line drawn across the page's first pictures: as it's drawn (the pen still down) the band it
// crosses looks as it does once it's lifted and dry
async function overPictures(page, pen, name, c) {
  await tool(page, 'Pen');
  // (a note in view with its picture over its words: across the picture, some px above the words)
  const words = await until(
    () =>
      page.evaluate(() =>
        [...document.querySelectorAll('#book .bk-words')]
          .map(w => w.getBoundingClientRect())
          .find(r => r.width > 100 && r.top - 60 > 90 && r.bottom < innerHeight - 120 && r.left > innerWidth / 2 - 200),
      ),
    `${name}: a note's picture in view`,
  );
  const y = Math.round(words.y - 30),
    x0 = Math.round(words.x + 10),
    x1 = Math.round(words.x + Math.min(words.width, 220));
  const points = Array.from({ length: 24 }, (_, i) => [x0 + ((x1 - x0) * i) / 23, y + 6 * Math.sin(i / 2)]);
  const clip = { x: x0 - 10, y: y - 14, width: x1 - x0 + 20, height: 28 };
  const blank = await page.screenshot({ clip });
  await pen.down(points[0]);
  for (const p of points.slice(1)) await pen.move(p);
  // (painted: the live line shows at the next frame, however long the engine takes to draw one. Headless WebKit's
  // come about a second apart here)
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  const wet = await page.screenshot({ clip });
  await c.shot(`pen-owned-${name}-drawing`, page);
  await pen.up(points.at(-1));
  await page.waitForTimeout(1200);
  const dry = await page.screenshot({ clip });
  await c.shot(`pen-owned-${name}-lifted`, page);
  const [drawn, moved] = await changed(page, blank, wet, dry);
  console.log(`${name}: the line dry over ${drawn} px, ${moved} px of it not where it showed while drawn`);
  assert.ok(drawn > 200, `${name}: the line is drawn (${drawn} px)`);
  assert.ok(
    moved < drawn * 0.15,
    `${name}: the line shows as it's drawn where it lies once lifted (${moved} of ${drawn} px)`,
  );
}

// Of three shots of one band (before, while drawing, once dry), the px the dry line changed, and of those, the px the
// shot while drawing doesn't show as dry
const changed = (page, ...shots) =>
  page.evaluate(
    async ([blank, wet, dry]) => {
      const px = async b64 => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const cv = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height }),
          g = cv.getContext('2d');
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, img.width, img.height).data;
      };
      const [a, w, d] = await Promise.all([blank, wet, dry].map(px));
      const differ = (p, q, i) => Math.max(...[0, 1, 2].map(k => Math.abs(p[i + k] - q[i + k]))) > 60;
      let drawn = 0,
        moved = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (differ(a, d, i)) drawn++;
        if (differ(w, d, i)) moved++;
      }
      return [drawn, moved];
    },
    shots.map(b => b.toString('base64')),
  );
