#!/usr/bin/env node
// The tactile modules on a small page in Chromium: a tap presses and releases once (in a phone's order, the click after
// the finger lifts), a flip ends turned, an opened card lands in its place and closes back into its tile, a drag let go
// past the threshold steps and a short or cancelled one springs back, and dropped tiles end at rest. A choice presses
// its key once by Space and once by an arrow, and not by Enter. With reduced motion, all at once.
//   node shared/tactile/tactile-check.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { playwright, openPage } from '../browser/browser.mjs';

const BASE = 'http://tactile.test';
const PAGE = `<!doctype html>
<meta name="viewport" content="width=device-width">
<style>
  body { margin: 0; font: 16px sans-serif; }
  .key { display: inline-block; width: 100px; height: 100px; margin: 10px; border: 0; background: #ccc; }
  #area { position: fixed; inset: 160px 0 0 0; }
  #card { position: absolute; left: 60px; top: 40px; width: 300px; height: 300px; background: #eee; }
</style>
<button class="key" id="press">Press</button><div class="key" id="tile"></div>
<div class="key drop"></div><div class="key drop"></div>
<label><input type="radio" name="choice" id="first" /><span class="key" id="first-key"></span></label>
<label><input type="radio" name="choice" /><span class="key" id="second-key"></span></label>
<div id="area"><div id="card"><div id="faces">A face</div></div></div>`;

const browser = await playwright().chromium.launch();
const { context, page, errors } = await openPage(browser, { viewport: { width: 600, height: 700 } });
await context.route(`${BASE}/**`, async route => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/') return route.fulfill({ contentType: 'text/html', body: PAGE });
  const file = /^\/shared\/tactile\/([a-z]+\.js)$/.exec(path)?.[1];
  if (!file) return route.fulfill({ status: 404, body: '' });
  return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL(file, import.meta.url)) });
});
const load = () =>
  page.evaluate(async () => {
    for (const name of ['press', 'flip', 'fly', 'swipe', 'drop'])
      window[name] = await import(`/shared/tactile/${name}.js`);
  });
const centre = async selector => {
  const box = await page.locator(selector).boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width };
};

try {
  await page.goto(`${BASE}/`);
  await load();

  // press: a tap lets go before its click, which comes 80 ms later, as on a phone
  await page.evaluate(() => {
    const key = document.querySelector('#press');
    window.pressed = { downs: 0, changes: [], clickAt: null };
    window.press.holdPresses(document.body, { keys: '.key', onDown: () => window.pressed.downs++ });
    new MutationObserver(() =>
      window.pressed.changes.push([performance.now(), key.classList.contains('down')]),
    ).observe(key, { attributeFilter: ['class'] });
    addEventListener(
      'click',
      event => {
        if (!event.isTrusted) return (window.pressed.clickAt = performance.now());
        event.stopImmediatePropagation();
        setTimeout(() => event.target.click(), 80);
      },
      true,
    );
  });
  const key = await centre('#press');
  await page.mouse.move(key.x, key.y);
  await page.mouse.down();
  await page.waitForTimeout(150); // (past the press's minimum: only the late click holds it down now)
  await page.mouse.up();
  await page.waitForTimeout(400);
  const tap = await page.evaluate(() => window.pressed);
  const [[, down], [upAt, up] = []] = tap.changes;
  assert.equal(tap.downs, 1, 'a tap plays its press once');
  assert.deepEqual([down, up, tap.changes.length], [true, false, 2], 'a tap goes down once and comes up once');
  assert.ok(upAt >= tap.clickAt, 'a key stays down until its late click has landed');

  await page.evaluate(() => (window.pressed = { downs: 0, changes: [], clickAt: null }));
  await page.focus('#press');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const typed = await page.evaluate(() => window.pressed);
  assert.deepEqual(
    [typed.downs, typed.changes.map(([, isDown]) => isDown)],
    [1, [true, false]],
    'Enter presses a key once',
  );
  // (Enter's click lands at once: the press still shows for its minimum)
  const [[typedDown], [typedUp]] = typed.changes,
    minimum = await page.evaluate(() => window.press.PRESS_MIN_MS);
  assert.ok(typedUp - typedDown >= minimum - 2, `a press shows for at least ${minimum} ms`);

  // a choice (a radio under a key, in its label) presses its key by Space, not by Enter (which chooses nothing), and an
  // arrow presses the one it chooses
  await page.evaluate(() => {
    const downs = [];
    for (const key of document.querySelectorAll('label .key'))
      new MutationObserver(() => key.classList.contains('down') && downs.push(key.id)).observe(key, {
        attributeFilter: ['class'],
      });
    window.pressed.downs = 0;
    window.choiceDowns = downs;
  });
  await page.focus('#first');
  await page.keyboard.press('Enter');
  await page.keyboard.press(' ');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  const choosing = await page.evaluate(() => ({
    downs: window.pressed.downs,
    keys: window.choiceDowns,
    checked: document.querySelector('input:checked + .key')?.id,
    stillDown: document.querySelectorAll('label .down').length,
  }));
  assert.deepEqual(
    choosing,
    { downs: 2, keys: ['first-key', 'second-key'], checked: 'second-key', stillDown: 0 },
    'a choice presses its key once by Space and once by an arrow, not by Enter, and comes back up',
  );

  // flip: turned at the end, and a second turn mid-flip refused
  const flipped = await page.evaluate(async () => {
    const faces = document.querySelector('#faces');
    let edges = 0;
    const turn = () => window.flip.flip(faces, { onEdge: () => edges++ });
    const started = [turn(), turn()];
    await new Promise(done => setTimeout(done, window.flip.FLIP_MS + 150));
    return { started, edges, moving: faces.getAnimations().length };
  });
  assert.deepEqual(flipped, { started: [true, false], edges: 1, moving: 0 }, 'a flip turns once and ends at rest');

  // fly: the card starts over its tile, lands in its own place, and closes back into the tile
  const tile = await centre('#tile'),
    card = await centre('#card');
  await page.evaluate(() => {
    window.flight = window.fly.flyOut(document.querySelector('#card'), document.querySelector('#tile'));
    window.flight.pause();
  });
  const start = await centre('#card');
  assert.ok(
    Math.hypot(start.x - tile.x, start.y - tile.y) < 2 && Math.abs(start.width - tile.width) < 2,
    'an opening card starts over its tile',
  );
  await page.evaluate(() => window.flight.finish());
  assert.deepEqual(await centre('#card'), card, 'an opened card lands in its own place');
  await page.evaluate(() => {
    window.flight = window.fly.flyBack(document.querySelector('#card'), document.querySelector('#tile'));
    window.flight.pause();
    window.flight.currentTime = window.fly.CLOSE_MS - 1;
  });
  const end = await centre('#card');
  assert.ok(Math.hypot(end.x - tile.x, end.y - tile.y) < 3, 'a closing card goes back into its tile');
  await page.evaluate(() => window.flight.finish());

  // swipe: the card follows the finger; past the threshold it steps, short of it it springs back
  await page.evaluate(() => {
    window.steps = [];
    window.swipes = window.swipe.followSwipes(document.querySelector('#area'), {
      card: () => document.querySelector('#card'),
      onStep: by => window.steps.push(by),
    });
  });
  const drag = async dx => {
    await page.mouse.move(card.x, card.y);
    await page.mouse.down();
    await page.mouse.move(card.x + dx / 2, card.y, { steps: 4 });
    await page.mouse.move(card.x + dx, card.y, { steps: 4 });
    const following = await page.evaluate(() => document.querySelector('#card').style.transform);
    await page.mouse.up();
    return following;
  };
  const following = await drag(-120);
  assert.match(following, /^translateX\(-120px\) rotate\(-/, 'a dragged card follows the finger and leans');
  assert.deepEqual(await page.evaluate(() => window.steps), [1], 'a drag to the left past the threshold steps on');
  assert.equal(await page.evaluate(() => window.swipes.wasSwipe()), true, "a drag's ending click isn't a tap");
  await drag(40);
  assert.deepEqual(
    await page.evaluate(() => [window.steps.length, document.querySelector('#card').style.transform]),
    [1, ''],
    'a short drag springs back without a step',
  );
  await page.mouse.move(card.x, card.y);
  await page.mouse.down();
  await page.mouse.move(card.x - 120, card.y, { steps: 4 });
  await page.mouse.move(card.x, card.y, { steps: 4 });
  await page.mouse.up();
  assert.deepEqual(
    await page.evaluate(() => [window.steps.length, window.swipes.wasSwipe()]),
    [1, true],
    'a drag that comes back to where it began lets go without a step, and its click is still no tap',
  );
  await page.mouse.move(card.x, card.y);
  await page.mouse.down();
  await page.mouse.move(card.x - 120, card.y, { steps: 4 });
  await page.evaluate(() =>
    document.querySelector('#card').dispatchEvent(new PointerEvent('pointercancel', { bubbles: true })),
  );
  await page.mouse.up();
  assert.deepEqual(
    await page.evaluate(() => [window.steps.length, document.querySelector('#card').style.transform]),
    [1, ''],
    'a drag the browser cancels springs back without a step',
  );
  await page.evaluate(() => window.swipes.wasSwipe());
  await page.mouse.click(card.x, card.y);
  assert.equal(await page.evaluate(() => window.swipes.wasSwipe()), false, 'a tap is a tap');

  // drop: every tile lands, clacks, and ends at rest
  const dropped = await page.evaluate(async () => {
    const tiles = [...document.querySelectorAll('.drop')],
      bounces = [];
    window.drop.dropTiles(tiles, { onBounce: (index, bounce) => bounces.push([index, bounce]) });
    await Promise.all(tiles.flatMap(tile => tile.getAnimations().map(animation => animation.finished)));
    await new Promise(done => setTimeout(done, 50));
    return { bounces, at: tiles.map(tile => getComputedStyle(tile).transform) };
  });
  assert.deepEqual(dropped.at, ['none', 'none'], 'dropped tiles end at rest');
  for (const index of [0, 1])
    assert.ok(
      dropped.bounces.some(([i, bounce]) => i === index && bounce === 0),
      `tile ${index} lands with a callback`,
    );

  // reduced motion: everything at once
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const still = await page.evaluate(() => {
    const faces = document.querySelector('#faces'),
      cardEl = document.querySelector('#card');
    let edges = 0;
    window.flip.flip(faces, { onEdge: () => edges++ });
    window.drop.dropTiles([...document.querySelectorAll('.drop')]);
    return {
      edges,
      opening: window.fly.flyOut(cardEl, document.querySelector('#tile')).effect.getTiming().duration,
      dropping: document.querySelector('.drop').getAnimations().length,
    };
  });
  assert.deepEqual(still, { edges: 1, opening: 0, dropping: 0 }, 'reduced motion lands everything at once');

  assert.deepEqual(errors, []);
  console.log('tactile-check: press, flip, fly, swipe and drop pass');
} finally {
  await browser.close();
}
