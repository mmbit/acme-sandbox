// book-check.mjs --stories 'live work': two devices share wet marks and trusted work writes debug lines on the open page.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fulfilPart } from '../../../shared/review/parts.mjs';
import { DESKTOP, MINI, UPRIGHT, bookOpen, pressAlong, until } from './kit.mjs';
import { watchedPage } from './start.mjs';

const WORK = 'https://scrap.preview.test';
const notebookJs = await readFile(new URL('../../../shared/notebook/notebook.js', import.meta.url), 'utf8');
const HTML = `<!doctype html><meta name="viewport" content="width=device-width"><title>Live work</title>
<style>body { margin: 0; font: 18px system-ui } #target { margin: 180px 24px 24px; padding: 24px; border: 1px solid; } button { min-height: 44px }</style>
<section id="target">The work being marked</section><button id="debug">Write debug line</button>
<script type="module">import * as notebook from '/notebook.js';
document.querySelector('#debug').onclick = () => notebook.send('debug', 'Frame 42: paused');</script>
<script src="/__review/review.js"></script>`;

export function messageStories(c) {
  return {
    'live work: wet marks reach a phone from a laptop and back, then clear with the note': browser => marks(browser, c),
    ...Object.fromEntries(
      [MINI, UPRIGHT].map(viewport => [
        `live work: debug lines on the open page, trusted frames alone, at ${viewport.width} × ${viewport.height}`,
        browser => debug(browser, c, viewport),
      ]),
    ),
  };
}

async function opened(browser, c, viewport) {
  const context = await c.hqIn(browser, viewport, { notebooks: {}, hasTouch: true, deviceScaleFactor: 1 });
  await context.route(`${WORK}/**`, r => {
    const path = new URL(r.request().url()).pathname;
    if (fulfilPart(r, path, c.reviewJs)) return;
    if (path === '/__hq-origin') return r.fulfill({ body: c.base });
    if (path === '/notebook.js') return r.fulfill({ contentType: 'text/javascript', body: notebookJs });
    if (path === '/__review/notes' && r.request().method() === 'POST') {
      const body = r.request().postDataJSON();
      const group = context.notebook.route(
        '/api/notebooks/groups/scrap',
        {},
        {
          anchor: body.element,
          words: body.note,
          said: body.said,
          snip: body.shot,
          owner: 'juno',
        },
      );
      return r.fulfill({ json: { ok: true, id: group.id, page: group.page } });
    }
    if (path.startsWith('/__review/')) return r.fulfill({ json: { show: false } });
    return r.fulfill({ contentType: 'text/html', body: HTML });
  });
  await context.route('**/api/preview/link', r => r.fulfill({ json: { url: r.request().postDataJSON().url } }));
  const { page, errors } = await watchedPage(context);
  await page.goto(`${c.base}/?intro=0&renderer=wire`);
  await page.waitForSelector('#loading.gone');
  await bookOpen(page, false);
  await page.evaluate(url => import('/shell/desk.js').then(m => m.openLink(url)), WORK);
  const frame = await until(() => page.frames().find(f => f.url().startsWith(WORK)), 'the work framed');
  await frame.locator('review-mode .ui').waitFor({ state: 'attached' });
  return { context, page, frame, errors };
}

async function debug(browser, c, viewport) {
  const s = await opened(browser, c, viewport);
  try {
    await bookOpen(s.page, true);
    await s.frame.locator('#debug').evaluate(el => el.click());
    const log = s.page.locator('#book .bk-messages');
    await log.waitFor();
    assert.match(await log.innerText(), /Frame 42: paused/);
    await s.page.evaluate(() => {
      const frame = document.querySelector('#viewer .pane.after iframe');
      const said = { hq: 'notebook', kind: 'debug', detail: 'forged' };
      dispatchEvent(
        new MessageEvent('message', { source: frame.contentWindow, origin: 'https://outside.test', data: said }),
      );
      dispatchEvent(new MessageEvent('message', { source: window, origin: 'https://scrap.preview.test', data: said }));
    });
    await s.frame.evaluate(() =>
      parent.postMessage(
        { hq: 'notebook', kind: 'context', detail: { level: 3, label: '<img src=x onerror=alert(1)>' } },
        '*',
      ),
    );
    await until(async () => (await log.innerText()).includes('level'), 'the structured context shown');
    assert.ok(!(await log.innerText()).includes('forged'), 'a wrong source or origin cannot write on the page');
    assert.equal(await log.locator('img').count(), 0, 'debug content stays text');
    await s.frame.evaluate(() => {
      const detail = {};
      detail.self = detail;
      parent.postMessage({ hq: 'notebook', kind: 'debug', detail }, '*');
    });
    await until(async () => (await log.innerText()).includes('(not shown:'), 'a failed detail says why');
    await c.shot(`live-debug-${viewport.width}`, s.page);
    await log.getByRole('button', { name: 'Close' }).click();
    assert.equal(await log.count(), 0, 'the debug log can be put away');
    await s.frame.locator('#debug').evaluate(el => el.click());
    await log.waitFor();
    assert.match(await log.innerText(), /Frame 42: paused/, 'later debug lines can open a fresh log');
    assert.ok(!(await log.innerText()).includes('level'), 'dismissed lines stay gone');
    assert.deepEqual(s.errors, []);
  } finally {
    await s.context.close();
  }
}

async function marks(browser, c) {
  const laptop = await opened(browser, c, DESKTOP);
  const phone = await opened(browser, c, { width: 390, height: 844 });
  const devices = [laptop, phone];
  const posted = [];
  try {
    for (const s of devices)
      await s.context.route('**/api/viewer/marks', async r => {
        const marks = r.request().postDataJSON();
        posted.push(marks);
        await Promise.all(
          devices.map(d =>
            d.page.evaluate(
              marks => import('/shell/events.js').then(m => m.onEvent({ type: 'viewmarks', marks })),
              marks,
            ),
          ),
        );
        await r.fulfill({ json: { ok: true } });
      });
    await phone.frame.evaluate(() =>
      parent.postMessage({ hq: 'review', marks: { url: 'https://foreign.preview.test/', ink: [] } }, '*'),
    );
    await oneMark(laptop, phone, false, c, posted);
    await oneMark(phone, laptop, true, c, posted);
    assert.ok(posted.length >= 4, 'marks crossed the device transport');
    assert.ok(
      posted.every(m => new URL(m.anchor.url).origin === WORK),
      'a frame cannot claim another origin for its marks',
    );
    await c.shot('live-marks-phone', phone.page);
    for (const s of devices) assert.deepEqual(s.errors, []);
  } finally {
    for (const s of devices) await s.context.close();
  }
}

async function oneMark(source, other, save, c, posted) {
  await source.page.locator('#viewer .pin').click();
  await source.frame.locator('review-mode .veil').waitFor();
  const target = await source.frame.locator('#target').evaluate(el => el.getBoundingClientRect().toJSON());
  const x = target.x + 20,
    y = target.y + 20;
  const points = save
    ? [
        [x, y],
        [x + 40, y + 25],
        [x + 80, y + 40],
      ]
    : ringAround(target);
  const hand = await pressAlong(source.frame, points.slice(0, 2), { lift: false });
  const ink = other.frame.locator('review-mode .remote');
  await until(() => visibleInk(ink), 'wet ink on the second device before the pen lifts');
  const first = await ink.screenshot();
  const firstPoints = posted.at(-1).anchor.ink[0].points.length;
  await hand.along(points.slice(2));
  if (!save) {
    await until(() => posted.at(-1)?.anchor.ink[0]?.points.length > firstPoints, 'the whole wet ring shared');
    assert.equal(posted.at(-1).anchor.el.selector, 'section#target', 'the first wet ring anchors to the circled work');
    await until(() => surroundsTarget(ink), 'the wet ring surrounds the target on the phone before the pen lifts');
  }
  await until(async () => !(await ink.screenshot()).equals(first), 'the wet line grows on the second device');
  await c.shot(`live-mark-${other.page.viewportSize().width}`, other.page);
  await hand.up();
  assert.ok(await visibleInk(ink), 'lifting keeps the open mark visible');
  if (save) {
    await source.frame.locator('review-mode textarea').fill('Keep this mark in the notebook');
    await source.frame.locator('review-mode .send').click();
  } else {
    await source.frame.evaluate(() => dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  }
  await until(async () => !(await visibleInk(ink)), 'saving or cancelling clears the mark on the second device');
}

function ringAround(target) {
  return Array.from({ length: 33 }, (_, i) => {
    const angle = Math.PI + (i * 2 * Math.PI) / 32;
    return [
      target.x + target.width / 2 + (target.width / 2 + 8) * Math.cos(angle),
      target.y + target.height / 2 + (target.height / 2 + 8) * Math.sin(angle),
    ];
  });
}

async function surroundsTarget(ink) {
  return ink.evaluate(canvas => {
    const target = document.querySelector('#target').getBoundingClientRect();
    const rect = canvas.getBoundingClientRect();
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (let i = 3; i < pixels.length; i += 4) {
      if (!pixels[i]) continue;
      const point = (i - 3) / 4;
      const x = rect.x + ((point % canvas.width) * rect.width) / canvas.width;
      const y = rect.y + (Math.floor(point / canvas.width) * rect.height) / canvas.height;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
    return left < target.left && top < target.top && right > target.right && bottom > target.bottom;
  });
}

async function visibleInk(canvas) {
  if (!(await canvas.count())) return false;
  return canvas.evaluate(c => {
    const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return pixels.some((v, i) => i % 4 === 3 && v > 0);
  });
}
